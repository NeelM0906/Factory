#!/bin/sh
# Simulates `claude auth status` returning failure (not authenticated).
echo "Not authenticated" >&2
exit 1
