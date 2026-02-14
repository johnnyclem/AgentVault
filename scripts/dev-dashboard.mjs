import { spawn } from 'node:child_process'

const tasks = [
  {
    name: 'core',
    command: 'npm',
    args: ['run', 'dev:core'],
  },
  {
    name: 'webapp',
    command: 'npm',
    args: ['run', 'dev:webapp'],
  },
]

const running = new Map()
let shuttingDown = false

function shutdown(signal = 'SIGTERM', exitCode = 0) {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  process.exitCode = exitCode

  for (const child of running.values()) {
    if (!child.killed) {
      child.kill(signal)
    }
  }

  setTimeout(() => {
    for (const child of running.values()) {
      if (!child.killed) {
        child.kill('SIGKILL')
      }
    }
  }, 2000).unref()
}

for (const task of tasks) {
  const child = spawn(task.command, task.args, {
    stdio: 'inherit',
    env: process.env,
  })

  running.set(task.name, child)

  child.on('exit', (code, signal) => {
    running.delete(task.name)

    if (shuttingDown) {
      if (running.size === 0) {
        process.exit(process.exitCode ?? 0)
      }
      return
    }

    if (signal) {
      console.error(`[dev:${task.name}] exited via signal ${signal}`)
      shutdown('SIGTERM', 1)
      return
    }

    if ((code ?? 0) !== 0) {
      console.error(`[dev:${task.name}] exited with code ${code}`)
      shutdown('SIGTERM', code ?? 1)
      return
    }

    if (running.size === 0) {
      process.exit(0)
    }
  })

  child.on('error', (error) => {
    console.error(`[dev:${task.name}] failed to start: ${error.message}`)
    shutdown('SIGTERM', 1)
  })
}

process.on('SIGINT', () => shutdown('SIGINT', 0))
process.on('SIGTERM', () => shutdown('SIGTERM', 0))
process.on('SIGHUP', () => shutdown('SIGTERM', 0))
