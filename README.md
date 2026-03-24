# Fire Emblem Discord Bot (POC)

This repository is now a proof-of-concept Discord tactical battle bot focused on movement.

## What is implemented

- One slash command: `/battle`.
- Four playable units with the requested base stats:
  - Alear
  - Vander
  - Clanne
  - Framme
- Allies spawn at:
  - `1A` Alear
  - `1B` Vander
  - `2A` Clanne
  - `2B` Framme
- Four level-1 enemies spawn in the opposite corner.
- Battle map embed image that renders:
  - Grid + coordinate labels (letters horizontal, numbers vertical)
  - Allies + enemies
- Movement interaction flow:
  1. Click **Move** (under battle embed).
  2. Pick one ally who has not moved this turn.
  3. Use **Left / Up / Right / Down** once or multiple times.
  4. Click **Confirm**.
  5. Main battle embed image updates with the new position.

> Phase logic is intentionally not implemented yet (as requested).

## Required assets

Put your unit images in these paths:

- `assets/players/alear.png`
- `assets/players/vander.png`
- `assets/players/clanne.png`
- `assets/players/framme.png`

Optional enemy images (fallback marker will be used if omitted):

- `assets/enemies/enemy1.png`
- `assets/enemies/enemy2.png`
- `assets/enemies/enemy3.png`
- `assets/enemies/enemy4.png`

Sprites are drawn at ~45% original size (clamped to tile size) during rendering.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create `.env`:

   ```bash
   DISCORD_TOKEN=your_bot_token
   DISCORD_CLIENT_ID=your_application_id
   DISCORD_GUILD_ID=your_test_server_id
   ```

3. Start bot:

   ```bash
   npm start
   ```

On startup, the bot registers the `/battle` slash command for the configured guild.

## Notes

- Current map defaults to an `8 x 8` coordinate grid.
- This is a single-channel, single-owner POC session model.
