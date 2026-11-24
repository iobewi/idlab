"""Persistent campaign records. Operation execution stays in the board broker."""

from datetime import UTC, datetime
import sqlite3
import uuid


class CampaignError(Exception):
    def __init__(self, status, code):
        self.status = status
        self.code = code


def timestamp():
    return datetime.now(UTC).isoformat(timespec="milliseconds")


class Campaigns:
    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
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
