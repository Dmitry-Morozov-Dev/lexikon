#!/usr/bin/env python3
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _specialty_lib import validate
ROOT = Path(__file__).resolve().parents[1]
try:
    validate(ROOT/'data/it-sysadmin.json', 400, 500)
except AssertionError as e:
    print('FAIL:', e); sys.exit(1)
