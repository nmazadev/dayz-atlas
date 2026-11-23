#!/usr/bin/env python3
"""Cut a high-resolution satellite image into tiles for the optional `tiles/` volume.

    python3 scripts/make_tiles.py chernarus satellite.tif          # → tiles/chernarus/satellite/
    python3 scripts/make_tiles.py livonia sat.png --out /srv/atlas-tiles

The image must be square and cover the whole world (top = north). The web app
prefers `tiles/<map>/` when it exists and falls back to the bundled official tiles.
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_data import MAPS, ROOT, build_tiles  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("map", choices=list(MAPS))
    ap.add_argument("image", type=Path)
    ap.add_argument("--out", type=Path, default=ROOT / "tiles", help="volume root (default: ./tiles)")
    ap.add_argument("--layer", choices=["satellite", "topo"], default="satellite")
    ap.add_argument("--quality", type=int, default=80, help="WebP quality (default: 80)")
    args = ap.parse_args()
    info = build_tiles(args.image, args.out / args.map / args.layer, args.quality)
    # index.json tells the app which maps have high-res tiles (one request instead of probing).
    index_path = args.out / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    index.setdefault(args.map, {})[args.layer] = info
    index_path.write_text(json.dumps(index, indent=2, sort_keys=True))
    print(f"{args.map} {args.layer}: {info['imageSize']} px, native zoom {info['maxNativeZoom']} → {args.out / args.map / args.layer}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
