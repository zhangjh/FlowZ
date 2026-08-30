/**
 * IPC 通道常量定义
 * 用于主进程和渲染进程之间的通信
 */

export const IPC_CHANNELS = {
  // 代理控制
  PROXY_START: 'proxy:start',
  PROXY_STOP: 'proxy:stop',
  PROXY_GET_STATUS: 'proxy:getStatus',
  PROXY_RESTART: 'proxy:restart',

  // 配置管理
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',
  CONFIG_UPDATE_MODE: 'config:updateMode',
  CONFIG_GET_VALUE: 'config:getValue',
  CONFIG_SET_VALUE: 'config:setValue',

  // 服务器管理
  SERVER_SWITCH: 'server:switch',
  SERVER_PARSE_URL: 'server:parseUrl',
  SERVER_GENERATE_URL: 'server:generateUrl',
  SERVER_ADD_FROM_URL: 'server:addFromUrl',
  SERVER_ADD: 'server:add',
  SERVER_UPDATE: 'server:update',
  SERVER_DELETE: 'server:delete',
  SERVER_GET_ALL: 'server:getAll',
  SERVER_PARSE_SUBSCRIPTION: 'server:parseSubscription',
  SERVER_ADD_SUBSCRIPTION: 'server:addSubscription',

  // 分组管理
  GROUP_CREATE: 'group:create',
  GROUP_UPDATE: 'group:update',
  GROUP_DELETE: 'group:delete',
  GROUP_SELECT: 'group:select',
  GROUP_ADD_SERVERS: 'group:addServers',
  GROUP_MOVE_SERVER: 'group:moveServer',
  GROUP_GET_ALL: 'group:getAll',
  GROUP_SHARE: 'group:share',

  // 路由规则管理
  RULES_GET_ALL: 'rules:getAll',
  RULES_ADD: 'rules:add',
  RULES_UPDATE: 'rules:update',
  RULES_DELETE: 'rules:delete',

  // 日志管理
  LOGS_GET: 'logs:get',
  LOGS_CLEAR: 'logs:clear',
  LOGS_SET_LEVEL: 'logs:setLevel',
  LOGS_OPEN_FOLDER: 'logs:openFolder',

  // 系统代理管理
  SYSTEM_PROXY_ENABLE: 'systemProxy:enable',
  SYSTEM_PROXY_DISABLE: 'systemProxy:disable',
  SYSTEM_PROXY_GET_STATUS: 'systemProxy:getStatus',

  // 自启动管理
  AUTO_START_SET: 'autoStart:set',
  AUTO_START_GET_STATUS: 'autoStart:getStatus',

  // 统计信息
  STATS_GET: 'stats:get',
  STATS_RESET: 'stats:reset',

  // 版本信息
  VERSION_GET_INFO: 'version:getInfo',

  // 更新管理
  UPDATE_CHECK: 'update:check',
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_INSTALL: 'update:install',
  UPDATE_SKIP: 'update:skip',
  UPDATE_OPEN_RELEASES: 'update:openReleases',

  // Shell 操作
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',

  // 自动选择
  AUTO_SELECT_GET_STATUS: 'autoSelect:getStatus',
  AUTO_SELECT_TEST_SERVERS: 'autoSelect:testServers',
  AUTO_SELECT_GET_BEST_SERVER: 'autoSelect:getBestServer',
  AUTO_SELECT_TRIGGER_FAILOVER: 'autoSelect:triggerFailover',

  // 更新事件 (主进程 -> 渲染进程)
  EVENT_UPDATE_PROGRESS: 'update:progress',

  // 管理员权限
  ADMIN_CHECK: 'admin:check',

  // 事件 (主进程 -> 渲染进程)
  EVENT_PROXY_STARTED: 'event:proxyStarted',
  EVENT_PROXY_STOPPED: 'event:proxyStopped',
  EVENT_PROXY_ERROR: 'event:proxyError',
  EVENT_PROXY_TESTING_STARTED: 'event:proxyTestingStarted',
  EVENT_PROXY_TESTING_COMPLETED: 'event:proxyTestingCompleted',
  EVENT_CONFIG_CHANGED: 'event:configChanged',
  EVENT_LOG_RECEIVED: 'event:logReceived',
  EVENT_STATS_UPDATED: 'event:statsUpdated',
  EVENT_CONNECTION_STATE_CHANGED: 'event:connectionStateChanged',
  EVENT_AUTO_SELECT_FAILOVER: 'event:autoSelectFailover',
  EVENT_AUTO_SELECT_TEST_COMPLETED: 'event:autoSelectTestCompleted',
  EVENT_AUTO_CONNECT: 'event:autoConnect',
  EVENT_PROXY_RESTARTING: 'event:proxyRestarting',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
