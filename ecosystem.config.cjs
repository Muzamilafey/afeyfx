/**
 * PM2 process file.
 *   pm2 start ecosystem.config.cjs --env production
 *
 * The API and trading engine run as ONE process in fork mode (instances: 1). Background jobs and
 * the trading engine must never run in two processes at once (duplicate orders). Do not switch
 * this to cluster mode without moving jobs to a single dedicated worker (or BullMQ + Redis).
 */
module.exports = {
  apps: [
    {
      name: 'afeyfx-server',
      cwd: './server',
      script: 'dist/server.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,
      max_memory_restart: '1G',
      kill_timeout: 15000,
      time: true,
      merge_logs: true,
      out_file: '/var/log/afeyfx/server.out.log',
      error_file: '/var/log/afeyfx/server.err.log',
      node_args: '--enable-source-maps',
      env_production: {
        NODE_ENV: 'production',
      },
    },
  ],
};
