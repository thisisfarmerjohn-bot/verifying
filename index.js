// index.js
import fs from 'fs';
import fetch from 'node-fetch';
import express from 'express';
import dotenv from 'dotenv';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  Routes,
  REST,
  ButtonStyle,
  ActionRowBuilder,
  ButtonBuilder,
  ComponentType,
  MessageFlags
} from 'discord.js';

dotenv.config();

/*
  CONFIG (env)
  - BOT_TOKEN
  - CLIENT_ID
  - CLIENT_SECRET
  - REDIRECT_URI
  - OWNER_IDS (comma separated)
  - USERS_FILE (optional)
  - CONFIG_FILE (optional)
  - SESSION_SECRET (not used here, but may be needed if you re-add web UI)
*/

const USERS_FILE = process.env.USERS_FILE || './data/users.json';
const CONFIG_FILE = process.env.CONFIG_FILE || './data/config.json';
const OWNER_IDS = (process.env.OWNER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

// Hard-coded guild/role IDs you supplied earlier:
const GUILD_ID = '1447283337130676407';
const VERIFIED_ROLE_ID = '1447283337470283777';
const MEDIA_ROLE_ID = '1451849497146687625';

// Page size for /userlist
const PAGE_SIZE = 20;
// Button expiration (ms)
const BUTTON_TTL = 2 * 60 * 1000; // 2 minutes

// Utility: load & save JSON files
function loadJson(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  } catch (err) {
    console.error(`Failed to load JSON from ${file}:`, err);
    return {};
  }
}
function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error(`Failed to save JSON to ${file}:`, err);
  }
}

// Ensure data dirs exist
if (!fs.existsSync('./data')) fs.mkdirSync('./data', { recursive: true });

let users = loadJson(USERS_FILE);
let config = loadJson(CONFIG_FILE);

// OAuth URL used by /send
const OAUTH_URL = `https://discord.com/oauth2/authorize?client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.REDIRECT_URI)}&response_type=code&scope=identify+guilds.join&prompt=consent`;

// Discord client & REST for commands
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences
  ],
  partials: [Partials.User, Partials.GuildMember]
});
const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

// Register commands (keeps everything in one place)
const commands = [
  { name: 'send', description: 'Send verification embed' },
  {
    name: 'setverified',
    description: 'Set channel for verified logs',
    options: [{ name: 'channel', description: 'Channel to send logs', type: 7, required: true }]
  },
  { name: 'userlist', description: 'Displays a paginated list of verified users' },
  {
    name: 'userip',
    description: 'Shows stored IP for a user ID',
    options: [{ name: 'userid', description: 'The user ID to check', type: 3, required: true }]
  },
  { name: 'useralts', description: 'Detect possible alts by grouping users with the same IP' },
  {
    name: 'addall',
    description: 'Invites all verified users to a server',
    options: [{ name: 'serverid', description: 'Server ID to add all users to', type: 3, required: true }]
  },
  {
    name: 'adduser',
    description: 'Invites one verified user to a server',
    options: [
      { name: 'userid', description: 'User ID to add', type: 3, required: true },
      { name: 'serverid', description: 'Server ID to add user to', type: 3, required: true }
    ]
  },
  {
    name: 'removeuser',
    description: 'Removes a user from users.json',
    options: [{ name: 'userid', description: 'User ID to remove', type: 3, required: true }]
  },
  { name: 'removeall', description: 'Removes all users from users.json' },
  {
    name: 'cleanup',
    description: 'Removes all users from users.json whose OAuth tokens are invalid or expired'
  }
];

(async () => {
  try {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('✅ Commands registered (global).');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
})();

client.once('ready', () => {
  console.log(`✅ Bot ready: ${client.user?.tag}`);
  
  // Start token refresh interval (every 5 hours)
  const REFRESH_INTERVAL = 5 * 60 * 60 * 1000; // 5 hours in milliseconds
  setInterval(refreshAllTokens, REFRESH_INTERVAL);
  console.log('🔄 Token refresh interval started (every 5 hours)');
  
  // Run initial refresh after 1 minute (to avoid startup spam)
  setTimeout(refreshAllTokens, 60000);
});

// Helper: format username robustly (avoid undefined#undefined)
function formatUserDisplay(userData) {
  // userData is the object saved in users.json (we stored .username as a string already),
  // but be defensive: userData may sometimes be incomplete.
  if (!userData) return 'UnknownUser';
  if (typeof userData.username === 'string' && userData.username.length > 0) return userData.username;
  return 'UnknownUser';
}

// Helper: refresh all user tokens
async function refreshAllTokens() {
  console.log('🔄 Starting token refresh cycle...');
  users = loadJson(USERS_FILE);
  const entries = Object.entries(users);
  
  if (entries.length === 0) {
    console.log('ℹ️ No users to refresh.');
    return;
  }
  
  let refreshed = 0;
  let deleted = 0;
  
  for (const [userId, userData] of entries) {
    // Delete users without refresh tokens
    if (!userData.refresh_token) {
      console.log(`🗑️ Deleting user ${userId} (no refresh token)`);
      delete users[userId];
      deleted++;
      continue;
    }
    
    try {
      const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.CLIENT_ID,
          client_secret: process.env.CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: userData.refresh_token
        })
      });
      
      const tokenData = await tokenRes.json();
      
      // Delete users whose token refresh failed
      if (!tokenData || !tokenData.access_token) {
        console.warn(`🗑️ Deleting user ${userId} (token refresh failed):`, tokenData);
        delete users[userId];
        deleted++;
        continue;
      }
      
      // Update access token and refresh token (Discord may provide a new refresh token)
      users[userId].access_token = tokenData.access_token;
      // Always save refresh token - use new one if provided, otherwise keep existing
      if (tokenData.refresh_token) {
        users[userId].refresh_token = tokenData.refresh_token;
      }
      // Ensure refresh_token is always saved (preserve existing if no new one provided)
      if (!users[userId].refresh_token) {
        users[userId].refresh_token = userData.refresh_token;
      }
      refreshed++;
    } catch (err) {
      // Delete users whose token refresh threw an error
      console.error(`🗑️ Deleting user ${userId} (error during refresh):`, err);
      delete users[userId];
      deleted++;
    }
  }
  
  // Always save the file after processing (in case users were deleted)
  saveJson(USERS_FILE, users);
  
  console.log(`✅ Token refresh complete: ${refreshed} refreshed, ${deleted} deleted`);
}

// Helper: build a page (embed + components) for userlist
function buildUserlistPage(usersObj, page, invokerId) {
  const all = Object.values(usersObj);
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  page = Math.min(Math.max(1, page), pages);

  const start = (page - 1) * PAGE_SIZE;
  const slice = all.slice(start, start + PAGE_SIZE);

  const lines = slice.map(u => {
    const name = formatUserDisplay(u);
    const id = u.id || 'UnknownID';
    const ip = u.ip || 'Unknown';
    return `• **${name}** | ID: \`${id}\` | IP: \`${ip}\``;
  });

  const embed = new EmbedBuilder()
    .setTitle(`👥 Verified Users — page ${page}/${pages}`)
    .setDescription(lines.length ? lines.join('\n') : 'No users on this page.')
    .setFooter({ text: `Total verified: ${total}` })
    .setColor('#3498db');

  // Buttons with encoded page & invoker id. Use customId format: userlist:<page>:<invokerId>:<timestamp>
  const timestamp = Date.now();
  const prevBtn = new ButtonBuilder()
    .setCustomId(`userlist_prev:${page - 1}:${invokerId}:${timestamp}`)
    .setLabel('⬅️ Previous')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(page <= 1);

  const nextBtn = new ButtonBuilder()
    .setCustomId(`userlist_next:${page + 1}:${invokerId}:${timestamp}`)
    .setLabel('➡️ Next')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(page >= pages);

  const row = new ActionRowBuilder().addComponents(prevBtn, nextBtn);

  return { embed, components: [row], meta: { page, pages, timestamp } };
}

// Interaction handler includes slash commands & button presses
client.on('interactionCreate', async (interaction) => {
  try {
    // Button interactions (pagination)
    if (interaction.isButton()) {
      const [prefix, pageStr, invokerId, createdAtStr] = interaction.customId.split(':');
      const createdAt = Number(createdAtStr || 0);

      // Only handle userlist buttons (others might exist)
      if (!prefix?.startsWith('userlist')) return;

      // Check TTL
      if (Date.now() - createdAt > BUTTON_TTL) {
        // Disable the buttons
        await interaction.update({ content: 'This pagination has expired.', components: [], embeds: [] }).catch(() => {});
        return;
      }

      // Only original invoker can use the buttons
      if (interaction.user.id !== invokerId) {
        return interaction.reply({ content: 'These buttons are restricted to the command invoker.', flags: MessageFlags.Ephemeral });
      }

      // compute target page
      let targetPage = parseInt(pageStr, 10);
      if (isNaN(targetPage) || targetPage < 1) targetPage = 1;

      // reload users fresh
      users = loadJson(USERS_FILE);

      const { embed, components } = buildUserlistPage(users, targetPage, invokerId);
      // update the message
      await interaction.update({ embeds: [embed], components }).catch(async (err) => {
        // fallback: send ephemeral
        console.error('Failed to update pagination message:', err);
        await interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral }).catch(() => {});
      });

      return;
    }

    // Slash commands
    if (!interaction.isChatInputCommand()) return;

    // Owner check
    if (!OWNER_IDS.includes(interaction.user.id)) {
      return interaction.reply({ content: '❌ You are not authorized to use this bot.', flags: MessageFlags.Ephemeral });
    }

    const cmd = interaction.commandName;
// /cleanup
if (cmd === 'cleanup') {
  users = loadJson(USERS_FILE);
  const entries = Object.entries(users);
  if (entries.length === 0) {
    return interaction.reply({ content: 'No users in users.json.', flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({ content: '🧹 Checking all users for invalid tokens...', flags: MessageFlags.Ephemeral });

  let removed = 0;
  for (const [id, u] of entries) {
    if (!u.access_token) {
      delete users[id];
      removed++;
      continue;
    }

    try {
      const res = await fetch('https://discord.com/api/users/@me', {
        headers: { Authorization: `Bearer ${u.access_token}` }
      });
      if (!res.ok) {
        delete users[id];
        removed++;
      }
    } catch {
      delete users[id];
      removed++;
    }
  }

  saveJson(USERS_FILE, users);
  await interaction.followUp({ content: `✅ Cleanup complete! Removed ${removed} invalid users.`, flags: MessageFlags.Ephemeral });
  return;
}

    // /send
    if (cmd === 'send') {
      const embed = new EmbedBuilder()
        .setTitle('✅ Verify Your Discord Account')
        .setDescription('Click the button below to verify your account through Discord’s official authorization window.')
        .setColor('#00b894');

      const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setURL(OAUTH_URL)
          .setLabel('🔗 Verify Account')
      );

      await interaction.reply({ embeds: [embed], components: [buttonRow], ephemeral: false });
      return;
    }

    // /setverified
    if (cmd === 'setverified') {
      const channel = interaction.options.getChannel('channel');
      config.verified_channel = channel.id;
      saveJson(CONFIG_FILE, config);
      await interaction.reply({ content: `✅ Verified log channel set to ${channel}`, flags: MessageFlags.Ephemeral });
      return;
    }

    // /userlist (paginated, first page)
    if (cmd === 'userlist') {
      // reload users
      users = loadJson(USERS_FILE);

      if (Object.keys(users).length === 0) {
        return interaction.reply({ content: 'No verified users found.', flags: MessageFlags.Ephemeral });
      }

      const invokerId = interaction.user.id;
      const page = 1;
      const { embed, components } = buildUserlistPage(users, page, invokerId);

      // reply with ephemeral message and components
      await interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
      return;
    }

    // /userip <userid> (shows that user's IP)
    if (cmd === 'userip') {
      const userId = interaction.options.getString('userid').trim();
      users = loadJson(USERS_FILE);
      const u = users[userId];
      if (!u) {
        return interaction.reply({ content: `❌ User ID \`${userId}\` not found in users.json.`, flags: MessageFlags.Ephemeral });
      }
      const name = formatUserDisplay(u);
      await interaction.reply({ content: `🔎 ${name} | ID: \`${userId}\` | IP: \`${u.ip || 'Unknown'}\``, flags: MessageFlags.Ephemeral });
      return;
    }

    // /useralts
    if (cmd === 'useralts') {
      users = loadJson(USERS_FILE);
      const byIp = {};
      for (const u of Object.values(users)) {
        const ip = u.ip || 'Unknown';
        if (!byIp[ip]) byIp[ip] = [];
        byIp[ip].push(u);
      }
      // keep only groups with >1 user
      const duplicates = Object.entries(byIp).filter(([ip, arr]) => arr.length > 1);
      if (duplicates.length === 0) {
        return interaction.reply({ content: '✅ No IPs with multiple verified users found.', flags: MessageFlags.Ephemeral });
      }

      // Build embed(s). If many groups, we will paginate the text inside a single embed (or truncate)
      const lines = [];
      for (const [ip, arr] of duplicates) {
        lines.push(`🧠 IP: \`${ip}\``);
        for (const u of arr) {
          lines.push(`• **${formatUserDisplay(u)}** | ID: \`${u.id}\``);
        }
        lines.push(''); // spacing
      }

      const text = lines.join('\n');
      const embed = new EmbedBuilder()
        .setTitle('🔎 Detected possible alts (shared IPs)')
        .setDescription(text.substring(0, 4096))
        .setColor('#f1c40f');

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

// /addall (rate limited)
if (cmd === 'addall') {
  const guildId = interaction.options.getString('serverid').trim();
  users = loadJson(USERS_FILE);

  const userEntries = Object.entries(users);
  if (userEntries.length === 0) {
    return interaction.reply({ content: '❌ No verified users found.', flags: MessageFlags.Ephemeral });
  }

  await interaction.reply({
    content: `🔄 Refreshing all tokens before inviting...`,
    flags: MessageFlags.Ephemeral
  });

  // Refresh all tokens first
  await refreshAllTokens();

  // Reload users after refresh (refreshAllTokens saves the file)
  users = loadJson(USERS_FILE);
  const refreshedUserEntries = Object.entries(users);
  
  if (refreshedUserEntries.length === 0) {
    return interaction.followUp({ content: '❌ No verified users found after token refresh.', flags: MessageFlags.Ephemeral });
  }

  await interaction.followUp({
    content: `🚀 Inviting **${refreshedUserEntries.length}** verified users to server ID **${guildId}**...\n(Processing ~5 users every 5 seconds to avoid rate limits)`,
    flags: MessageFlags.Ephemeral
  });

  const BATCH_SIZE = 5; // number of users per batch
  const DELAY = 5000;   // delay between batches in ms
  let success = 0;
  let failed = 0;

  for (let i = 0; i < refreshedUserEntries.length; i += BATCH_SIZE) {
    const batch = refreshedUserEntries.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async ([id, u]) => {
      if (!u.access_token) {
        console.warn(`⚠️ User ${id} has no access_token, skipping invite`);
        failed++;
        return;
      }
      try {
        const res = await fetch(`https://discord.com/api/guilds/${guildId}/members/${id}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bot ${process.env.BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ access_token: u.access_token })
        });
        if (res.ok) {
          success++;
          console.log(`✅ Invited user ${id} using access_token`);
        } else {
          const errorText = await res.text().catch(() => 'Unknown error');
          console.warn(`❌ Failed to invite user ${id}: HTTP ${res.status} - ${errorText}`);
          failed++;
        }
      } catch (err) {
        console.error(`❌ Error inviting user ${id}:`, err);
        failed++;
      }
    }));

    if (i + BATCH_SIZE < refreshedUserEntries.length) {
      await new Promise(res => setTimeout(res, DELAY)); // wait between batches
    }
  }

  await interaction.followUp({ content: `✅ Invite process complete! Success: **${success}**, Failed: **${failed}**.`, flags: MessageFlags.Ephemeral });
  return;
}

    // /adduser
    if (cmd === 'adduser') {
      const userId = interaction.options.getString('userid').trim();
      const guildId = interaction.options.getString('serverid').trim();
      users = loadJson(USERS_FILE);
      const u = users[userId];
      if (!u || !u.access_token) {
        return interaction.reply({ content: `❌ User ID \`${userId}\` not found or has no access token.`, flags: MessageFlags.Ephemeral });
      }

      try {
        console.log(`🔄 Inviting user ${userId} using access_token to server ${guildId}`);
        const res = await fetch(`https://discord.com/api/guilds/${guildId}/members/${userId}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bot ${process.env.BOT_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ access_token: u.access_token })
        });
        if (!res.ok) {
          const errorText = await res.text().catch(() => 'Unknown error');
          throw new Error(`HTTP ${res.status}: ${errorText}`);
        }
        console.log(`✅ Successfully invited user ${userId} using access_token`);
        await interaction.reply({ content: `✅ Invited ${formatUserDisplay(u)} to server ${guildId}.`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        console.error(`❌ adduser error for ${userId}:`, err);
        await interaction.reply({ content: `❌ Failed to invite user: ${err.message}`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    // /removeuser
    if (cmd === 'removeuser') {
      const userId = interaction.options.getString('userid').trim();
      users = loadJson(USERS_FILE);
      if (!users[userId]) {
        return interaction.reply({ content: `❌ That user ID does not exist in users.json.`, flags: MessageFlags.Ephemeral });
      }
      delete users[userId];
      saveJson(USERS_FILE, users);
      await interaction.reply({ content: `🗑️ Removed user ID \`${userId}\` from users.json.`, flags: MessageFlags.Ephemeral });
      return;
    }

    // /removeall
    if (cmd === 'removeall') {
      users = {};
      saveJson(USERS_FILE, users);
      await interaction.reply({ content: '🧹 All users have been removed from users.json.', flags: MessageFlags.Ephemeral });
      return;
    }
  } catch (err) {
    console.error('interactionCreate error:', err);
    try { if (interaction.replied || interaction.deferred) await interaction.followUp({ content: '❌ An error occurred.', flags: MessageFlags.Ephemeral }); else await interaction.reply({ content: '❌ An error occurred.', flags: MessageFlags.Ephemeral }); } catch {}
  }
});

// Express server for OAuth2 callback — assigns Verified role after storing user
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/callback', async (req, res) => {
  const code = req.query.code;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'Unknown';

  if (!code) {
    return res.status(400).send('Missing code.');
  }

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: process.env.REDIRECT_URI
      })
    });

    const tokenData = await tokenRes.json();

    if (!tokenData || !tokenData.access_token) {
      console.error('No access token received:', tokenData);
      return res.status(500).send('Failed to get access token from Discord.');
    }

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `${tokenData.token_type} ${tokenData.access_token}` }
    });
    const userData = await userRes.json();

    // Build robust display name
    const maybeName =
      (userData.global_name || userData.username || (userData.user && userData.user.username) || '').trim();
    const discriminator = (userData.discriminator && userData.discriminator !== '0') ? `#${userData.discriminator}` : '';
    const fullUsername = (maybeName || 'UnknownUser') + discriminator;

    // store
    users = loadJson(USERS_FILE); // reload to not clobber concurrent changes
    users[userData.id] = {
      id: userData.id,
      username: fullUsername,
      verifiedAt: new Date().toISOString(),
      ip,
      avatar: userData.avatar || null,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token || null
    };
    saveJson(USERS_FILE, users);

    // Assign Verified role (if possible)
    try {
      const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
      if (guild) {
        // Try to fetch member; if member isn't in guild, we can't assign role
        const member = await guild.members.fetch(userData.id).catch(() => null);
        if (member) {
          await member.roles.add(VERIFIED_ROLE_ID).catch((e) => {
            console.warn('Failed to add Verified role:', e?.message || e);
          });
          console.log(`Assigned Verified role to ${fullUsername} (${userData.id})`);
        } else {
          console.log(`User ${userData.id} isn't a member of guild ${GUILD_ID}; skipped role add.`);
        }
      } else {
        console.log('Guild fetch failed for Verified role assignment.');
      }
    } catch (err) {
      console.error('Error assigning Verified role:', err);
    }

    // Log to configured channel (if set)
    if (config.verified_channel) {
      const channel = await client.channels.fetch(config.verified_channel).catch(() => null);
      if (channel) {
        const display = userData.global_name || userData.username || 'UnknownUser';
        await channel.send({
          content: `✅ ${display} verified.`,
          files: [USERS_FILE]
        }).catch((e) => console.warn('Failed to send verified log message:', e?.message || e));
      }
    }

    // Render a nice success page
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Verified Successfully</title>
<style>
  :root { --g1:#0f2027; --g2:#203a43; --g3:#2c5364; --accent1:#00b894; --accent2:#00e676; }
  html,body{height:100%;margin:0;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:radial-gradient(circle at top, var(--g1),var(--g2),var(--g3));color:#fff}
  .card{margin:6vh auto;padding:30px;border-radius:14px;background:rgba(255,255,255,0.04);max-width:420px;text-align:center;backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,0.5)}
  img.avatar{width:110px;height:110px;border-radius:50%;border:3px solid var(--accent2);object-fit:cover;margin-bottom:16px}
  h1{margin:0 0 10px;font-size:1.8rem;color:var(--accent2)}
  p{margin:6px 0;color:#e6f2ef}
  .username{color:var(--accent1);font-weight:700}
  .btn{display:inline-block;margin-top:18px;padding:12px 22px;border-radius:10px;color:#fff;text-decoration:none;font-weight:700;background:linear-gradient(135deg,var(--accent1),var(--accent2));transition:transform .18s ease}
  .btn:hover{transform:scale(1.03)}
  .muted{font-size:.85rem;color:#cde8df;margin-top:8px}
</style>
</head>
<body>
  <div class="card">
    <img class="avatar" src="https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'"/>
    <h1>✅ Verified Successfully!</h1>
    <p>Welcome, <span class="username">${fullUsername}</span></p>
    <p class="muted">Your Discord account has been verified safely.</p>
    <a class="btn" href="https://discord.com/app">Return to Discord</a>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error('Callback error:', err);
    return res.status(500).send('Internal server error during verification.');
  }
});

// Presence listener: add/remove media role when custom status equals exactly "/grin"
client.on('presenceUpdate', async (oldPresence, newPresence) => {
  try {
    if (!newPresence) return;
    // Only handle presences in the configured guild
    if (!newPresence.guild || newPresence.guild.id !== GUILD_ID) return;

    const member = newPresence.member;
    if (!member) return;

    // custom status is activity of type 4
    const custom = newPresence.activities?.find(a => a.type === 4);
    const state = (custom && typeof custom.state === 'string') ? custom.state.trim() : '';

    // Exactly "/grin" -> give role; otherwise remove role if present
    if (state.toLowerCase().includes('/grin')) {
      if (!member.roles.cache.has(MEDIA_ROLE_ID)) {
        await member.roles.add(MEDIA_ROLE_ID).catch((e) => {
          console.warn(`Failed to add media role to ${member.user.tag}:`, e?.message || e);
        });
        console.log(`Added media role to ${member.user.tag}`);
      }
    } else {
      if (member.roles.cache.has(MEDIA_ROLE_ID)) {
        await member.roles.remove(MEDIA_ROLE_ID).catch((e) => {
          console.warn(`Failed to remove media role from ${member.user.tag}:`, e?.message || e);
        });
        console.log(`Removed media role from ${member.user.tag}`);
      }
    }
  } catch (err) {
    console.error('presenceUpdate error:', err);
  }
});
import multer from 'multer';
app.use(express.urlencoded({ extended: true }));
const upload = multer({ dest: 'uploads/' });

// Upload form (GET)
app.get('/upload', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Upload users.json</title>
<style>
  body { font-family: Arial; background: #10151a; color: #eee; display:flex; align-items:center; justify-content:center; height:100vh; }
  form { background:#18222c; padding:30px; border-radius:10px; box-shadow:0 0 15px rgba(0,0,0,0.4); }
  input,button { margin-top:10px; padding:8px; width:100%; border-radius:6px; border:none; }
  input[type=password], input[type=file]{ background:#222d38; color:#fff;}
  button { background:#00b894; color:#fff; font-weight:bold; cursor:pointer; }
  button:hover { background:#00e676; }
</style>
</head>
<body>
<form method="POST" action="/upload" enctype="multipart/form-data">
  <h2>Replace users.json</h2>
  <label>Password:</label>
  <input type="password" name="pass" required>
  <label>File:</label>
  <input type="file" name="file" accept=".json" required>
  <button type="submit">Upload</button>
</form>
</body>
</html>`);
});

// Upload handler (POST)
app.post('/upload', upload.single('file'), (req, res) => {
  const pass = req.body.pass;
  if (pass !== process.env.ADMIN_PASS) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(403).send('❌ Unauthorized');
  }

  const filePath = req.file.path;
  try {
    const newData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // Backup current users.json if it exists
    if (fs.existsSync(USERS_FILE)) {
      fs.copyFileSync(USERS_FILE, USERS_FILE.replace('.json', '_backup.json'));
    }

    // Replace users.json
    fs.writeFileSync(USERS_FILE, JSON.stringify(newData, null, 2));
    fs.unlinkSync(filePath);

    res.send('<h1>✅ users.json replaced successfully!</h1><p>Your new user list has been uploaded and saved.</p>');
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).send('❌ Failed to process uploaded file.');
  }
});
app.listen(PORT, () => console.log(`🌐 OAuth callback server listening on port ${PORT}`));
client.login(process.env.BOT_TOKEN).catch(err => console.error('Failed to login:', err));









