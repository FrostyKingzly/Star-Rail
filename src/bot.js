require('dotenv').config();

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const { createCanvas, loadImage } = require('canvas');
const fs = require('node:fs/promises');
const path = require('node:path');

const GRID_ROWS = 8;
const GRID_COLS = 8;
const CELL_SIZE = 100;
const GRID_PADDING = 60;

const PLAYER_STATS = {
  Alear: { level: 1, class: 'Dragon Child', hp: 22, str: 6, mag: 0, dex: 5, spd: 7, def: 5, res: 3, lck: 5, bld: 4, mov: 4 },
  Vander: { level: 1, class: 'Paladin', hp: 40, str: 11, mag: 5, dex: 10, spd: 8, def: 10, res: 8, lck: 6, bld: 8, mov: 6 },
  Clanne: { level: 1, class: 'Mage', hp: 19, str: 1, mag: 8, dex: 11, spd: 9, def: 4, res: 7, lck: 4, bld: 4, mov: 4 },
  Framme: { level: 1, class: 'Martial Monk', hp: 18, str: 3, mag: 5, dex: 8, spd: 7, def: 4, res: 8, lck: 5, bld: 3, mov: 4 },
};

const PLAYER_IMAGE_FILES = {
  Alear: path.resolve('assets/players/alear.png'),
  Vander: path.resolve('assets/players/vander.png'),
  Clanne: path.resolve('assets/players/clanne.png'),
  Framme: path.resolve('assets/players/framme.png'),
};

const ENEMY_IMAGE_FILES = [
  path.resolve('assets/enemies/enemy1.png'),
  path.resolve('assets/enemies/enemy2.png'),
  path.resolve('assets/enemies/enemy3.png'),
  path.resolve('assets/enemies/enemy4.png'),
];

const PLAYER_ORDER = ['Alear', 'Vander', 'Clanne', 'Framme'];
const PLAYER_STARTS = {
  Alear: toPos('1A'),
  Vander: toPos('1B'),
  Clanne: toPos('2A'),
  Framme: toPos('2B'),
};

const activeBattles = new Map();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, () => {
  console.log(`Ready as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'battle') {
        await handleBattleCommand(interaction);
      }
      return;
    }

    if (!interaction.isButton()) {
      return;
    }

    const battle = activeBattles.get(interaction.channelId);
    if (!battle) {
      await interaction.reply({ content: 'No active battle in this channel. Use `/battle` first.', ephemeral: true });
      return;
    }

    if (battle.ownerId !== interaction.user.id) {
      await interaction.reply({ content: 'Only the player who started this battle can control it in this POC.', ephemeral: true });
      return;
    }

    await handleBattleButton(interaction, battle);
  } catch (error) {
    console.error(error);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: 'Something went wrong while handling that interaction.', ephemeral: true });
    } else {
      await interaction.reply({ content: 'Something went wrong while handling that interaction.', ephemeral: true });
    }
  }
});

async function handleBattleCommand(interaction) {
  const existing = activeBattles.get(interaction.channelId);
  if (existing) {
    await interaction.reply({ content: 'A battle is already active in this channel.', ephemeral: true });
    return;
  }

  const imageCache = await loadAllSprites();
  const battle = createBattleState(interaction.user.id, imageCache);
  activeBattles.set(interaction.channelId, battle);

  const { embed, attachment, components } = await buildBattleResponse(battle);
  const message = await interaction.reply({
    embeds: [embed],
    files: [attachment],
    components,
    fetchReply: true,
  });

  battle.messageId = message.id;
}

async function handleBattleButton(interaction, battle) {
  const [root, action, value] = interaction.customId.split(':');
  if (root !== 'battle') {
    return;
  }

  if (action === 'open-move') {
    if (battle.turn.movedThisTurn.length >= PLAYER_ORDER.length) {
      await interaction.reply({ content: 'All allies have already moved this turn.', ephemeral: true });
      return;
    }

    const selectionRow = new ActionRowBuilder();
    for (const name of PLAYER_ORDER) {
      const alreadyMoved = battle.turn.movedThisTurn.includes(name);
      selectionRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`battle:choose:${name}`)
          .setLabel(name)
          .setStyle(ButtonStyle.Primary)
          .setDisabled(alreadyMoved),
      );
    }

    await interaction.reply({
      content: 'Choose a character to move.',
      components: [selectionRow],
      ephemeral: true,
    });
    return;
  }

  if (action === 'choose') {
    if (!PLAYER_ORDER.includes(value)) {
      await interaction.reply({ content: 'Unknown character.', ephemeral: true });
      return;
    }

    if (battle.turn.movedThisTurn.includes(value)) {
      await interaction.reply({ content: `${value} has already moved this turn.`, ephemeral: true });
      return;
    }

    battle.turn.selectedUnit = value;
    battle.turn.previewPos = { ...battle.allies[value].pos };

    await interaction.update(buildMovementPrompt(battle, `${value} selected. Choose a direction, then confirm.`));
    return;
  }

  if (action === 'step') {
    if (!battle.turn.selectedUnit || !battle.turn.previewPos) {
      await interaction.reply({ content: 'Pick a character first from Move.', ephemeral: true });
      return;
    }

    const candidate = nextStep(battle.turn.previewPos, value);
    if (!isInsideGrid(candidate)) {
      await interaction.reply({ content: 'That move goes out of bounds.', ephemeral: true });
      return;
    }

    if (isOccupiedByAnyUnit(battle, candidate, battle.turn.selectedUnit)) {
      await interaction.reply({ content: 'That tile is occupied.', ephemeral: true });
      return;
    }

    battle.turn.previewPos = candidate;
    await interaction.update(buildMovementPrompt(battle, `${battle.turn.selectedUnit} preview: ${fromPos(candidate)}`));
    return;
  }

  if (action === 'confirm') {
    const unitName = battle.turn.selectedUnit;
    if (!unitName || !battle.turn.previewPos) {
      await interaction.reply({ content: 'Pick a character first from Move.', ephemeral: true });
      return;
    }

    battle.allies[unitName].pos = { ...battle.turn.previewPos };
    battle.turn.movedThisTurn.push(unitName);
    battle.turn.selectedUnit = null;
    battle.turn.previewPos = null;

    const { embed, attachment, components } = await buildBattleResponse(battle);
    await interaction.update({
      content: `${unitName} moved.`,
      embeds: [embed],
      files: [attachment],
      components,
    });
    return;
  }
}

function buildMovementPrompt(battle, message) {
  const selected = battle.turn.selectedUnit;
  const preview = battle.turn.previewPos ? fromPos(battle.turn.previewPos) : 'N/A';

  const movementButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('battle:step:left').setLabel('Left').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('battle:step:up').setLabel('Up').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('battle:step:right').setLabel('Right').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('battle:step:down').setLabel('Down').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('battle:confirm:move').setLabel('Confirm').setStyle(ButtonStyle.Success),
  );

  return {
    content: `${message}\nSelected: **${selected ?? 'None'}**\nPreview tile: **${preview}**`,
    components: [movementButtons],
    embeds: [],
    files: [],
  };
}

function createBattleState(ownerId, imageCache) {
  const allies = {};
  for (const name of PLAYER_ORDER) {
    allies[name] = {
      name,
      stats: PLAYER_STATS[name],
      pos: { ...PLAYER_STARTS[name] },
      sprite: imageCache.players[name],
    };
  }

  const enemyStartTiles = [
    { row: GRID_ROWS - 1, col: GRID_COLS - 1 },
    { row: GRID_ROWS - 1, col: GRID_COLS - 2 },
    { row: GRID_ROWS - 2, col: GRID_COLS - 1 },
    { row: GRID_ROWS - 2, col: GRID_COLS - 2 },
  ];

  const enemies = enemyStartTiles.map((pos, idx) => ({
    id: `Enemy ${idx + 1}`,
    level: 1,
    pos,
    sprite: imageCache.enemies[idx],
  }));

  return {
    ownerId,
    messageId: null,
    allies,
    enemies,
    turn: {
      movedThisTurn: [],
      selectedUnit: null,
      previewPos: null,
    },
  };
}

async function buildBattleResponse(battle) {
  const imageBuffer = await renderMapImage(battle);
  const attachment = new AttachmentBuilder(imageBuffer, { name: 'battle-map.png' });

  const movedList = battle.turn.movedThisTurn.length
    ? battle.turn.movedThisTurn.join(', ')
    : 'None yet';

  const embed = new EmbedBuilder()
    .setTitle('Fire Emblem POC Battle')
    .setDescription(
      `Allies start at 1A, 1B, 2A, 2B. Enemies are in the opposite corner.\n` +
        `Moved this turn: **${movedList}**`,
    )
    .setImage('attachment://battle-map.png')
    .setColor(0x4c8f3d);

  const moveRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('battle:open-move:menu')
      .setLabel('Move')
      .setStyle(ButtonStyle.Primary),
  );

  return {
    embed,
    attachment,
    components: [moveRow],
  };
}

async function renderMapImage(battle) {
  const width = GRID_PADDING + GRID_COLS * CELL_SIZE + 20;
  const height = GRID_PADDING + GRID_ROWS * CELL_SIZE + 20;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#102215';
  ctx.fillRect(0, 0, width, height);

  drawGrid(ctx);
  drawCoordinates(ctx);

  for (const allyName of PLAYER_ORDER) {
    const unit = battle.allies[allyName];
    drawUnitSprite(ctx, unit.sprite, unit.pos, '#4ea7ff', allyName[0]);
  }

  for (const enemy of battle.enemies) {
    drawUnitSprite(ctx, enemy.sprite, enemy.pos, '#ff4f4f', 'E');
  }

  return canvas.toBuffer('image/png');
}

function drawGrid(ctx) {
  for (let row = 0; row < GRID_ROWS; row += 1) {
    for (let col = 0; col < GRID_COLS; col += 1) {
      const x = GRID_PADDING + col * CELL_SIZE;
      const y = GRID_PADDING + row * CELL_SIZE;
      const dark = (row + col) % 2 === 0;
      ctx.fillStyle = dark ? '#2e4c2f' : '#3d603d';
      ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);
      ctx.strokeStyle = '#183019';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, CELL_SIZE, CELL_SIZE);
    }
  }
}

function drawCoordinates(ctx) {
  ctx.fillStyle = '#dceac2';
  ctx.font = 'bold 24px sans-serif';

  for (let col = 0; col < GRID_COLS; col += 1) {
    const label = String.fromCharCode(65 + col);
    const x = GRID_PADDING + col * CELL_SIZE + CELL_SIZE / 2 - 8;
    const y = 36;
    ctx.fillText(label, x, y);
  }

  for (let row = 0; row < GRID_ROWS; row += 1) {
    const label = String(row + 1);
    const x = 24;
    const y = GRID_PADDING + row * CELL_SIZE + CELL_SIZE / 2 + 8;
    ctx.fillText(label, x, y);
  }
}

function drawUnitSprite(ctx, sprite, pos, outlineColor, fallbackLabel) {
  const x = GRID_PADDING + pos.col * CELL_SIZE;
  const y = GRID_PADDING + pos.row * CELL_SIZE;

  const centerX = x + CELL_SIZE / 2;
  const centerY = y + CELL_SIZE / 2;

  ctx.strokeStyle = outlineColor;
  ctx.lineWidth = 4;
  ctx.strokeRect(x + 8, y + 8, CELL_SIZE - 16, CELL_SIZE - 16);

  if (!sprite) {
    ctx.fillStyle = outlineColor;
    ctx.beginPath();
    ctx.arc(centerX, centerY, 24, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#0c0c0c';
    ctx.font = 'bold 24px sans-serif';
    ctx.fillText(fallbackLabel, centerX - 8, centerY + 8);
    return;
  }

  const scaledWidth = Math.min(CELL_SIZE - 10, sprite.width * 0.45);
  const scaledHeight = Math.min(CELL_SIZE - 10, sprite.height * 0.45);
  const drawX = centerX - scaledWidth / 2;
  const drawY = centerY - scaledHeight / 2;

  ctx.drawImage(sprite, drawX, drawY, scaledWidth, scaledHeight);
}

function nextStep(pos, direction) {
  if (direction === 'left') return { row: pos.row, col: pos.col - 1 };
  if (direction === 'right') return { row: pos.row, col: pos.col + 1 };
  if (direction === 'up') return { row: pos.row - 1, col: pos.col };
  if (direction === 'down') return { row: pos.row + 1, col: pos.col };
  return { ...pos };
}

function isInsideGrid(pos) {
  return pos.row >= 0 && pos.row < GRID_ROWS && pos.col >= 0 && pos.col < GRID_COLS;
}

function isOccupiedByAnyUnit(battle, candidate, movingUnitName) {
  for (const name of PLAYER_ORDER) {
    if (name === movingUnitName) continue;
    const pos = battle.allies[name].pos;
    if (pos.row === candidate.row && pos.col === candidate.col) return true;
  }

  for (const enemy of battle.enemies) {
    if (enemy.pos.row === candidate.row && enemy.pos.col === candidate.col) return true;
  }

  return false;
}

function toPos(coord) {
  const row = Number.parseInt(coord, 10) - 1;
  const colChar = coord.replace(/\d+/g, '').toUpperCase();
  const col = colChar.charCodeAt(0) - 65;
  return { row, col };
}

function fromPos(pos) {
  const letter = String.fromCharCode(65 + pos.col);
  return `${pos.row + 1}${letter}`;
}

async function loadSpriteIfExists(filePath) {
  try {
    await fs.access(filePath);
    return await loadImage(filePath);
  } catch {
    return null;
  }
}

async function loadAllSprites() {
  const players = {};
  for (const [name, filePath] of Object.entries(PLAYER_IMAGE_FILES)) {
    players[name] = await loadSpriteIfExists(filePath);
  }

  const enemies = [];
  for (const filePath of ENEMY_IMAGE_FILES) {
    enemies.push(await loadSpriteIfExists(filePath));
  }

  return { players, enemies };
}

async function registerSlashCommands() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !clientId || !guildId) {
    throw new Error('Set DISCORD_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID in .env');
  }

  const commands = [new SlashCommandBuilder().setName('battle').setDescription('Start a Fire Emblem-style proof-of-concept battle.')].map((c) =>
    c.toJSON(),
  );

  const rest = new REST({ version: '10' }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  console.log('Registered /battle command.');
}

async function main() {
  await registerSlashCommands();
  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
