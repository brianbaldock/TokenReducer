#!/usr/bin/env node
import { workerMain } from '../../bulk-reader/scripts/lib/worker.mjs';
await workerMain('code-writer');
