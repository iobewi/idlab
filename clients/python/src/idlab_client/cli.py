import argparse
from importlib.resources import files
from pathlib import Path
import sys


def init() -> int:
    target = Path("tests") / "hardware"
    templates = files("idlab_client").joinpath("templates", "hardware")
    try:
        target.mkdir(parents=True, exist_ok=True)
        for template in sorted(templates.iterdir(), key=lambda item: item.name):
            destination = target / template.name.removesuffix(".tmpl")
            contents = template.read_bytes()
            try:
                with destination.open("xb") as output:
                    output.write(contents)
            except FileExistsError:
                print(f"Kept {destination} (already exists)")
            else:
                print(f"Created {destination}")
    except OSError as error:
        print(f"idlab init: {error}", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="idlab", description="IDLab hardware test tools")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "init", help="generate a pytest hardware recipe in the current project",
        description="Generate tests/hardware/ in the current project and keep existing files.",
    )
    parser.parse_args(argv)
    return init()
