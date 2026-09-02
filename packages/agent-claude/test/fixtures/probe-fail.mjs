#!/usr/bin/env node
// Simulates `claude auth status` returning failure (not authenticated).
process.stderr.write("Not authenticated\n");
process.exit(1);
