#!/usr/bin/env python3
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _specialty_lib import assemble
ROOT = Path(__file__).resolve().parents[1]
assemble(ROOT/'scripts/idioms_build/batches', ROOT/'data/idioms.json', 'idiom', 300, 400, require_space=False)
