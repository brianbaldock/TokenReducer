#!/usr/bin/env node
import { workerMain } from './lib/worker.mjs';
await workerMain('bulk-reader');
