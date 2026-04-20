// Prints the JS-side ARCHITECTURE_SCHEMA_V1 as canonical JSON to stdout.
// tests/test_parity.py compares this to blindspotcheck/schemas/architecture-v1.json.

import { ARCHITECTURE_SCHEMA_V1 } from '../../web/schema.js';

process.stdout.write(JSON.stringify(ARCHITECTURE_SCHEMA_V1));
