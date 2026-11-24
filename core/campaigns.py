"""Persistent campaign records. Operation execution stays in the board broker."""

from datetime import UTC, date, datetime
import re
import sqlite3
import uuid


STATES = ("active", "abort_requested", "aborted", "finished")


class CampaignError(Exception):
    def __init__(self, status, code):
        self.status = status
        self.code = code


def search_parameters(query):
    allowed = {"q", "state", "verdict", "from", "to", "limit", "offset"}
    if set(query) - allowed or any(len(query.getall(key, [])) > 1 for key in allowed - {"state"}):
        raise CampaignError(400, "invalid_campaign_filters")

    q = query.get("q", "").strip()
    verdict = query.get("verdict", "").strip()
    states = tuple(dict.fromkeys(query.getall("state", [])))
    if len(q) > 120 or len(verdict) > 80 or any(state not in STATES for state in states):
        raise CampaignError(400, "invalid_campaign_filters")

    def day(key):
        if key not in query:
            return None
        value = query[key]
        if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
            raise ValueError
        return date.fromisoformat(value)

    def integer(key, default, minimum, maximum):
        value = query.get(key, str(default))
        if not re.fullmatch(r"[0-9]{1,10}", value) or not minimum <= int(value) <= maximum:
            raise ValueError
        return int(value)

    try:
        start, end = day("from"), day("to")
        if start is not None and end is not None and start > end:
            raise ValueError
        limit = integer("limit", 25, 1, 100)
        offset = integer("offset", 0, 0, 1_000_000_000)
    except ValueError as error:
        raise CampaignError(400, "invalid_campaign_filters") from error
    return dict(q=q, states=states, verdict=verdict, start=start, end=end, limit=limit, offset=offset)


def timestamp():
    return datetime.now(UTC).isoformat(timespec="milliseconds")


class Campaigns:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.create_function("casefold", 1, str.casefold, deterministic=True)
        self.db.execute("""
            CREATE TABLE IF NOT EXISTS campaigns (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                state TEXT NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT,
                abort_requested_at TEXT,
                verdict TEXT,
                reason TEXT
            )
        """)
        self.in_flight = {}

    def close(self):
        self.db.close()

    def get(self, campaign_id):
        row = self.db.execute("SELECT * FROM campaigns WHERE id = ?", (campaign_id,)).fetchone()
        if row is None:
            raise CampaignError(404, "campaign_not_found")
        return dict(row) | {"in_flight": self.in_flight.get(campaign_id, 0)}

    def search(self, *, q, states, verdict, start, end, limit, offset):
        filters, parameters = [], []
        if q:
            filters.append("(instr(casefold(name), ?) > 0 OR instr(id, ?) > 0)")
            parameters.extend((q.casefold(), q.casefold()))
        if states:
            filters.append(f"state IN ({', '.join('?' for _ in states)})")
            parameters.extend(states)
        if verdict:
            filters.append("verdict = ?")
            parameters.append(verdict)
        if start is not None:
            filters.append("started_at >= ?")
            parameters.append(f"{start}T00:00:00.000+00:00")
        if end is not None:
            filters.append("started_at <= ?")
            parameters.append(f"{end}T23:59:59.999+00:00")

        where = " WHERE " + " AND ".join(filters) if filters else ""
        counts = dict.fromkeys(STATES, 0)
        # Keep the counts and page on the same SQLite snapshot.
        self.db.execute("BEGIN")
        with self.db:
            for row in self.db.execute(
                f"SELECT state, COUNT(*) AS count FROM campaigns{where} GROUP BY state", parameters,
            ):
                counts[row["state"]] = row["count"]
            rows = self.db.execute(
                f"SELECT * FROM campaigns{where} ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?",
                [*parameters, limit, offset],
            ).fetchall()
        return {
            "items": [dict(row) | {"in_flight": self.in_flight.get(row["id"], 0)} for row in rows],
            "counts": counts, "total": sum(counts.values()), "limit": limit, "offset": offset,
        }

    def start(self, name):
        campaign_id = uuid.uuid4().hex
        with self.db:
            self.db.execute(
                "INSERT INTO campaigns (id, name, state, started_at) VALUES (?, ?, 'active', ?)",
                (campaign_id, name, timestamp()),
            )
        return self.get(campaign_id)

    def finish(self, campaign_id, verdict):
        campaign = self.get(campaign_id)
        if campaign["state"] == "finished" and campaign["verdict"] == verdict:
            return campaign
        if campaign["state"] != "active":
            raise CampaignError(409, "campaign_not_active")
        if campaign["in_flight"]:
            raise CampaignError(409, "campaign_busy")
        with self.db:
            self.db.execute(
                "UPDATE campaigns SET state = 'finished', ended_at = ?, verdict = ? WHERE id = ?",
                (timestamp(), verdict, campaign_id),
            )
        return self.get(campaign_id)

    def abort(self, campaign_id, reason):
        campaign = self.get(campaign_id)
        if campaign["state"] == "finished":
            raise CampaignError(409, "campaign_not_active")
        if campaign["state"] == "active":
            now = timestamp()
            pending = campaign["in_flight"] > 0
            with self.db:
                self.db.execute(
                    "UPDATE campaigns SET state = ?, abort_requested_at = ?, ended_at = ?, reason = ? WHERE id = ?",
                    ("abort_requested" if pending else "aborted", now, None if pending else now, reason, campaign_id),
                )
        elif campaign["state"] == "abort_requested" and not campaign["in_flight"]:
            self._complete_abort(campaign_id)
        return self.get(campaign_id)

    def enter(self, campaign_id):
        campaign = self.get(campaign_id)
        if campaign["state"] != "active":
            raise CampaignError(409, "campaign_not_active")
        self.in_flight[campaign_id] = campaign["in_flight"] + 1

    def leave(self, campaign_id):
        remaining = self.in_flight[campaign_id] - 1
        if remaining:
            self.in_flight[campaign_id] = remaining
        else:
            del self.in_flight[campaign_id]
            self._complete_abort(campaign_id)

    def _complete_abort(self, campaign_id):
        with self.db:
            self.db.execute(
                "UPDATE campaigns SET state = 'aborted', ended_at = ? WHERE id = ? AND state = 'abort_requested'",
                (timestamp(), campaign_id),
            )
