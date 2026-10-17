#!/usr/bin/env python3
# Deprecated: the script is scripts/chat-post.mjs now (Node only); this forwards to it.
import os, subprocess, sys
sys.exit(subprocess.call(['node', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'chat-post.mjs')] + sys.argv[1:]))
