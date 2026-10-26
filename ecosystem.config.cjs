module.exports = {
  apps: [
    {
      name: "code-workspace",
      script: "dist/server/server/index.js",
      cwd: __dirname,
      interpreter: process.execPath,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      restart_delay: 2000,
      min_uptime: "5s",
      max_restarts: 10,
      env: {
        NODE_ENV: "production",
        HOST: process.env.HOST ?? "127.0.0.1",
        PORT: "43110"
      },
      out_file: "/tmp/code-workspace-pm2-out.log",
      error_file: "/tmp/code-workspace-pm2-error.log",
      merge_logs: true,
      time: true
    }
  ]
};
