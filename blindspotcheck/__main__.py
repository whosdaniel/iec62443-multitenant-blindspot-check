"""Allow `python -m blindspotcheck` as an alias for the console entrypoint."""

from .cli import main

if __name__ == "__main__":
    raise SystemExit(main())
