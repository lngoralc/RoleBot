import * as config from './vars';
import { buildNewCommands, commands } from '../commands/commandHandler';
import { guildUpdate } from '../events/guildUpdate';
import { InteractionHandler } from './services/interactionHandler';
import { LogService } from './services/logService';
import { PermissionService } from './services/permissionService';
import { ReactionHandler } from './services/reactionHandler';
import { DataSource } from 'typeorm';
import { Category, GuildConfig, JoinRole, ReactMessage, ReactRole } from './database/entities';

import * as Discord from 'discord.js';
import { DELETE_JOIN_ROLE, GET_GUILD_JOIN_ROLES } from './database/queries/joinRole.query';
import { DELETE_REACT_MESSAGE_BY_ROLE_ID } from './database/queries/reactMessage.query';
import { DELETE_REACT_ROLE_BY_ROLE_ID } from './database/queries/reactRole.query';
import { SlashCommand } from '../commands/command';

import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';

import { setTimeout } from 'node:timers/promises';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  integrations: [
    nodeProfilingIntegration(),
  ],
  // Performance Monitoring
  tracesSampleRate: 1.0, //  Capture 100% of the transactions

  // Set sampling rate for profiling - this is relative to tracesSampleRate
  profilesSampleRate: 1.0,
});


export class RoleBot extends Discord.Client {
  config: typeof config;
  commands: Discord.Collection<string, SlashCommand>;

  // "Services"
  log: LogService;
  permissionService: PermissionService;
  reactHandler: ReactionHandler;

  constructor() {
    super({
      intents: [
        Discord.IntentsBitField.Flags.Guilds,
        Discord.IntentsBitField.Flags.GuildMembers,
        Discord.IntentsBitField.Flags.GuildMessageReactions,
      ],
      partials: [
        Discord.Partials.Message,
        Discord.Partials.Channel,
        Discord.Partials.Reaction,
      ],
      // RoleBot does a lot of role "pings" for visuals, don't allow it to actually mention roles. 
      allowedMentions: { parse: [] },
    });

    this.config = config;
    this.commands = commands();

    this.log = new LogService('RoleBot');
    this.permissionService = new PermissionService(this);
    this.reactHandler = new ReactionHandler();

    this.on('ready', (): void => {
      this.log.debug(`[Started]: ${new Date()}`);
      this.log.debug(
        `RoleBot reporting for duty. Currently watching ${this.guilds.cache.size} guilds.`,
      );

      // Discord will eventually drop the presence if it's not "updated" periodically.
      setInterval(() => this.updatePresence(), 10000);
    });

    this.on('shardError', (e) => {
      this.log.error(`Encountered shard error.`);
      this.log.critical(`${e}`);
    });

    this.on('interactionCreate', async (interaction) =>
      InteractionHandler.handleInteraction(interaction, this),
    );

    this.on('guildCreate', (guild) => {
      // If the client isn't ready then spawns are still sharding.
      if (!this.isReady()) {
        return;
      }

      guildUpdate(guild, 'Joined', this).catch((e) =>
        this.log.error(`Failed to send webhook for guild join.\n${e}`),
      );
    });
    this.on('guildDelete', (guild) => {
      // If the client isn't ready then spawns are still sharding.
      if (!this.isReady()) {
        return;
      }

      guildUpdate(guild, 'Left', this).catch((e) =>
        this.log.error(`Failed to send webhook for guild leave.\n${e}`),
      );
    });
    // React role handling
    this.on('messageReactionAdd', async (...r) => {
      // matching remove-role-delay, so roles aren't re-added before even being initially removed
      await setTimeout(1500);
      this.reactHandler
        .handleReaction(...r, 'add')
        .catch((e) => this.log.error(e));
      // Remove join roles once any react role has been added
      try {
        const member = r[0].message.guild?.members.cache.get(r[1].id)
        if (!member) return; // member will always be defined unless Discord itself bugged, but vscode is highlighting everything with red if I don't include this
        const joinRoles = await GET_GUILD_JOIN_ROLES(member.guild.id);
        
        // Abort if no join roles, or member already has a role higher than the join roles
        // (assumes all join roles are lower in the role hierarchy than all reaction roles,
        // so having a higher role implies join roles were already previously removed)
        if (!joinRoles.length) return;
        if (member.roles.highest.id != joinRoles[0].roleId) return;

        // delay before removing join role, so if users accidentally double-tap the first react role
        // they have time to re-add it before join role permissions are removed
        await setTimeout(5000);
        member.roles.remove(joinRoles.map((r) => r.roleId)).catch((e) => {
          this.log.debug(`Issue removing member join roles\n${e}`, member.guild.id);
        });
      } catch (e) {
        this.log.error(`Failed to get join roles to remove for new member.\n${e}`);
      }
    });
    this.on('messageReactionRemove', async (...r) => {
      // short delay before removing roles so they have time to re-add the role if need be
      await setTimeout(1500);
      this.reactHandler
        .handleReaction(...r, 'remove')
        .catch((e) => this.log.error(e));
    });
    this.on('guildMemberAdd', async (member) => {
      try {
        const joinRoles = await GET_GUILD_JOIN_ROLES(member.guild.id);

        if (!joinRoles.length) return;

        member.roles.add(joinRoles.map((r) => r.roleId)).catch((e) => {
          this.log.debug(`Issue giving member join roles\n${e}`, member.guild.id);
        });
      } catch (e) {
        this.log.error(`Failed to get join roles for new member.\n${e}`, member.guild.id);
      }
    });
    // To help try and prevent unknown role errors
    this.on('roleDelete', async (role) => {
      try {
        await DELETE_JOIN_ROLE(role.id);
        await DELETE_REACT_MESSAGE_BY_ROLE_ID(role.id);
        await DELETE_REACT_ROLE_BY_ROLE_ID(role.id);
      } catch (e) {
        this.log.error(
          `Failed to delete react role info on role[${role.id}] delete.\n${e}`,
          role.guild.id,
        );
      }
    });
  }

  public start = async () => {
    const dataSource = new DataSource({
      type: 'postgres',
      host: config.POSTGRES_HOST,
      username: config.POSTGRES_USER,
      password: config.POSTGRES_PASSWORD,
      port: 5432,
      database: config.POSTGRES_DATABASE,
      entities: [ReactMessage, ReactRole, Category, GuildConfig, JoinRole],
      logging: ['error', 'warn'],
      synchronize: config.SYNC_DB,
      poolErrorHandler: (error) => {
        this.log.error(`DataSource pool error. Shards[${this.shard?.ids}]\n${error}`);
      },
      maxQueryExecutionTime: 1000,
    });

    await dataSource.initialize()
      .catch((error) => this.log.critical(`DataSource error on initialization.\n${error}`));

    this.log.info(`Connecting to Discord with bot token.`);
    await this.login(this.config.TOKEN);
    this.log.info('Bot connected.');

    // 741682757486510081 - New RoleBot application.
    //await buildNewCommands(true, config.CLIENT_ID !== '741682757486510081'); commented since not first-time startup anymore
     await buildNewCommands(false, config.CLIENT_ID !== '741682757486510081');
  };

  private updatePresence = () => {
    if (!this.user)
      return this.log.error(`Can't set presence due to client user missing.`);

    this.user.setPresence({
      activities: [
        {
          name: 'Use /help for commands!',
          type: Discord.ActivityType.Listening,
        },
        {
          name: 'Check out rolebot.gg!',
          type: Discord.ActivityType.Streaming,
        },
        {
          name: 'I use slash commands!',
          type: Discord.ActivityType.Watching,
        },
      ],
      status: 'dnd',
    });
  };
}
