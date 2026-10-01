#!/usr/bin/env python3
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from _specialty_lib import assemble
ROOT = Path(__file__).resolve().parents[1]
assemble(ROOT/'scripts/discourse_build/batches', ROOT/'data/discourse.json', 'discourse', 150, 250, default_level='b1-c1', default_bucket='speech')
