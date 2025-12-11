# Obsidian Cortex

Obsidian Cortex is an agentic knowledge management plugin for Obsidian that prioritizes mobile compatibility, safe secret storage, and model routing primitives. This repository currently ships the core plugin scaffold with secure storage helpers for API keys and basic commands for persisting OpenAI credentials.

## Development

1. Install dependencies with `npm install`.
2. Run `npm run build` to produce `main.js` for loading into your Obsidian `.obsidian/plugins/obsidian-cortex` directory.

The plugin avoids Node-only filesystem APIs and relies on Obsidian surfaces to remain compatible with desktop and mobile builds.
