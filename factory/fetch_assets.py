import argparse
import json
import subprocess
from pathlib import Path


def download_drive_file(file_id: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://drive.google.com/uc?id={file_id}"
    subprocess.run(["gdown", url, "-O", str(destination)], check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--lead", required=True, help="Path to lead manifest JSON")
    parser.add_argument("--out", default="work", help="Working directory")
    args = parser.parse_args()

    lead_path = Path(args.lead)
    lead = json.loads(lead_path.read_text(encoding="utf-8"))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    resolved = {"slug": lead["slug"], "venue_name": lead["venue_name"], "files": {}}
    for name, spec in lead["assets"].items():
        destination = out / spec["filename"]
        print(f"Downloading {name} -> {destination}")
        download_drive_file(spec["drive_id"], destination)
        if not destination.exists() or destination.stat().st_size == 0:
            raise RuntimeError(f"Downloaded asset is empty: {name}")
        resolved["files"][name] = str(destination)

    (out / "resolved_assets.json").write_text(
        json.dumps(resolved, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(resolved, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
