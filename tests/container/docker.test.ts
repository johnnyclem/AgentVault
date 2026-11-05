/**
 * Unit tests for src/container/docker.ts with a recording fake CommandRunner.
 * They pin the exact argv handed to `docker` and every rejection path. The
 * output fixtures below are REAL captures from Docker 29.9.2 (see the
 * integration test for the same commands against the live daemon).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_HELPER_CAPS,
  DockerRuntime,
  buildRunArgs,
  classifyDockerFailure,
  parseDockerLabels,
  renderEnvFile,
} from '../../src/container/docker.js';
import { ContainerError, DEFAULT_LIMITS, LABEL_AGENT, LABEL_MANAGED, LABEL_ROLE } from '../../src/container/types.js';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  ContainerErrorCode,
  ContainerSpec,
} from '../../src/container/types.js';

// ---------------------------------------------------------------------------
// Real fixtures (captured from the daemon in this sandbox)
// ---------------------------------------------------------------------------

/** `docker image inspect --format '{{json .}}' busybox:1.37` on Docker 29.9.2 (no Config.Labels, no Config.User). */
export const REAL_IMAGE_BUSYBOX = String.raw`{"Id":"sha256:30ecbe1509090b38ef3260f3609d64d8261230464eaa4d235901db496e9647fb","RepoTags":["busybox:1.37"],"RepoDigests":["busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"],"Created":"2024-09-26T21:31:42Z","Config":{"Env":["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],"Cmd":["sh"]},"Architecture":"amd64","Os":"linux","Size":4421262,"GraphDriver":{"Data":{"MergedDir":"/var/lib/avd/overlay2/c95c1b62c2fccadc88413600ebd0fc81ec6ede068df338e88a27ae8d580f5a1d/merged","UpperDir":"/var/lib/avd/overlay2/c95c1b62c2fccadc88413600ebd0fc81ec6ede068df338e88a27ae8d580f5a1d/diff","WorkDir":"/var/lib/avd/overlay2/c95c1b62c2fccadc88413600ebd0fc81ec6ede068df338e88a27ae8d580f5a1d/work"},"Name":"overlay2"},"RootFS":{"Type":"layers","Layers":["sha256:5a9bfd996c6d49c6c3cb4ddfb76e8d09cf16b6b7cf6601d1f2dffbdbc3edb5d4"]},"Metadata":{"LastTagTime":"0001-01-01T00:00:00Z"}}`;

/** Same command for an image built with USER 10001:10001 and LABEL agentvault.manifest. */
export const REAL_IMAGE_LABELED = String.raw`{"Id":"sha256:f5478df9cb3c442e0377af56938cc2fe07dc193efb29d821d7d0c52c95258562","RepoTags":["avt-a-fixture:latest"],"RepoDigests":[],"Comment":"buildkit.dockerfile.v0","Created":"2024-09-26T21:31:42Z","Config":{"User":"10001:10001","Env":["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],"Cmd":["sh"],"Labels":{"agentvault.managed":"true","agentvault.manifest":"{\"schemaVersion\":1,\"name\":\"fixture\"}"},"ArgsEscaped":true},"Architecture":"amd64","Os":"linux","Size":4421262,"GraphDriver":{"Data":{"MergedDir":"/var/lib/avd/overlay2/c95c1b62c2fccadc88413600ebd0fc81ec6ede068df338e88a27ae8d580f5a1d/merged","UpperDir":"/var/lib/avd/overlay2/c95c1b62c2fccadc88413600ebd0fc81ec6ede068df338e88a27ae8d580f5a1d/diff","WorkDir":"/var/lib/avd/overlay2/c95c1b62c2fccadc88413600ebd0fc81ec6ede068df338e88a27ae8d580f5a1d/work"},"Name":"overlay2"},"RootFS":{"Type":"layers","Layers":["sha256:5a9bfd996c6d49c6c3cb4ddfb76e8d09cf16b6b7cf6601d1f2dffbdbc3edb5d4"]},"Metadata":{"LastTagTime":"2026-11-05T05:24:30.13128046Z"}}`;

/** `docker container inspect --format '{{json .}}'` of a container started with -e API_KEY=sk-FIXTURE-SECRET-123 (value is a fixture, not a real key). */
export const REAL_CONTAINER_INSPECT = String.raw`{"Id":"07e0c866ed5d900d94047cc092809c840d3473db0d2148fa242f2a13dde652be","Created":"2026-11-05T05:24:30.215315873Z","Path":"sleep","Args":["30"],"State":{"Status":"running","Running":true,"Paused":false,"Restarting":false,"OOMKilled":false,"Dead":false,"Pid":15787,"ExitCode":0,"Error":"","StartedAt":"2026-11-05T05:24:30.23144229Z","FinishedAt":"0001-01-01T00:00:00Z"},"Image":"sha256:f5478df9cb3c442e0377af56938cc2fe07dc193efb29d821d7d0c52c95258562","ResolvConfPath":"/var/lib/avd/containers/07e0c866ed5d900d94047cc092809c840d3473db0d2148fa242f2a13dde652be/resolv.conf","HostnamePath":"/var/lib/avd/containers/07e0c866ed5d900d94047cc092809c840d3473db0d2148fa242f2a13dde652be/hostname","HostsPath":"/var/lib/avd/containers/07e0c866ed5d900d94047cc092809c840d3473db0d2148fa242f2a13dde652be/hosts","LogPath":"/var/lib/avd/containers/07e0c866ed5d900d94047cc092809c840d3473db0d2148fa242f2a13dde652be/07e0c866ed5d900d94047cc092809c840d3473db0d2148fa242f2a13dde652be-json.log","Name":"/avt-a-fx","RestartCount":0,"Driver":"overlay2","Platform":"linux","MountLabel":"","ProcessLabel":"","AppArmorProfile":"","ExecIDs":null,"HostConfig":{"Binds":null,"ContainerIDFile":"","LogConfig":{"Type":"json-file","Config":{}},"NetworkMode":"none","PortBindings":{},"RestartPolicy":{"Name":"no","MaximumRetryCount":0},"AutoRemove":false,"VolumeDriver":"","VolumesFrom":null,"ConsoleSize":[0,0],"CapAdd":null,"CapDrop":["ALL"],"CgroupnsMode":"host","Dns":null,"DnsOptions":[],"DnsSearch":[],"ExtraHosts":null,"GroupAdd":null,"IpcMode":"private","Cgroup":"","Links":null,"OomScoreAdj":0,"PidMode":"","Privileged":false,"PublishAllPorts":false,"ReadonlyRootfs":true,"SecurityOpt":["no-new-privileges"],"Tmpfs":{"/tmp":"rw,nosuid,nodev,size=16m"},"UTSMode":"","UsernsMode":"","ShmSize":67108864,"Runtime":"runc","Isolation":"","CpuShares":0,"Memory":67108864,"NanoCpus":500000000,"CgroupParent":"","BlkioWeight":0,"BlkioWeightDevice":[],"BlkioDeviceReadBps":[],"BlkioDeviceWriteBps":[],"BlkioDeviceReadIOps":[],"BlkioDeviceWriteIOps":[],"CpuPeriod":0,"CpuQuota":0,"CpuRealtimePeriod":0,"CpuRealtimeRuntime":0,"CpusetCpus":"","CpusetMems":"","Devices":[],"DeviceCgroupRules":null,"DeviceRequests":null,"MemoryReservation":0,"MemorySwap":67108864,"MemorySwappiness":null,"OomKillDisable":false,"PidsLimit":128,"Ulimits":null,"CpuCount":0,"CpuPercent":0,"IOMaximumIOps":0,"IOMaximumBandwidth":0,"Mounts":[{"Type":"volume","Source":"avt-a-fx-data","Target":"/data"}],"MaskedPaths":["/proc/acpi","/proc/asound","/proc/interrupts","/proc/kcore","/proc/keys","/proc/latency_stats","/proc/sched_debug","/proc/scsi","/proc/timer_list","/proc/timer_stats","/sys/devices/virtual/powercap","/sys/firmware"],"ReadonlyPaths":["/proc/bus","/proc/fs","/proc/irq","/proc/sys","/proc/sysrq-trigger"],"Init":true},"GraphDriver":{"Data":{"ID":"07e0c866ed5d900d94047cc092809c840d3473db0d2148fa242f2a13dde652be","LowerDir":"/var/lib/avd/overlay2/b37dadd58f90284dbbacaa7f6cd7e65589ce9cf15def00afd77a924656bd52dc-init/diff:/var/lib/avd/overlay2/c95c1b62c2fccadc88413600ebd0fc81ec6ede068df338e88a27ae8d580f5a1d/diff","MergedDir":"/var/lib/avd/overlay2/b37dadd58f90284dbbacaa7f6cd7e65589ce9cf15def00afd77a924656bd52dc/merged","UpperDir":"/var/lib/avd/overlay2/b37dadd58f90284dbbacaa7f6cd7e65589ce9cf15def00afd77a924656bd52dc/diff","WorkDir":"/var/lib/avd/overlay2/b37dadd58f90284dbbacaa7f6cd7e65589ce9cf15def00afd77a924656bd52dc/work"},"Name":"overlay2"},"Mounts":[{"Type":"volume","Name":"avt-a-fx-data","Source":"/var/lib/avd/volumes/avt-a-fx-data/_data","Destination":"/data","Driver":"local","Mode":"z","RW":true,"Propagation":""}],"Config":{"Hostname":"07e0c866ed5d","Domainname":"","User":"10001:10001","AttachStdin":false,"AttachStdout":false,"AttachStderr":false,"Tty":false,"OpenStdin":false,"StdinOnce":false,"Env":["API_KEY=sk-FIXTURE-SECRET-123","PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],"Cmd":["sleep","30"],"Image":"avt-a-fixture:latest","Volumes":null,"WorkingDir":"","Entrypoint":null,"Labels":{"agentvault.agent":"fx","agentvault.managed":"true","agentvault.manifest":"{\"schemaVersion\":1,\"name\":\"fixture\"}","agentvault.role":"agent"}},"NetworkSettings":{"SandboxID":"a139542f8ffe3584271574aecf07fb645246260ee06a9721a8be0e2ed78e287f","SandboxKey":"/run/avd/netns/a139542f8ffe","Ports":{},"Networks":{"none":{"IPAMConfig":null,"Links":null,"Aliases":null,"DriverOpts":null,"GwPriority":0,"NetworkID":"9967e4cdff4fa01606bdddbe847eca85da7acdc5066f3f09858b25723c25ac02","EndpointID":"2ca494a2823ac8434a2535963b94612f1e75b36894d9431787a2442b52f895cb","Gateway":"","IPAddress":"","MacAddress":"","IPPrefixLen":0,"IPv6Gateway":"","GlobalIPv6Address":"","GlobalIPv6PrefixLen":0,"DNSNames":null}}}}`;

const REAL_PS_ROW = String.raw`{"id":"07e0c866ed5d","names":"avt-a-fx","image":"avt-a-fixture:latest","state":"running","status":"Up Less than a second","createdAt":"2026-11-05 05:24:30 +0000 UTC","labels":"agentvault.agent=fx,agentvault.managed=true,agentvault.manifest={\"schemaVersion\":1,\"name\":\"fixture\"},agentvault.role=agent","role":"agent","agent":"fx"}`;

/** A container that inherited a hostile image label: the flat string lies, .Label does not. */
const REAL_PS_ROW_SPOOFED = String.raw`{"id":"e70c1f7d694a","names":"avt-a-probe-l1","image":"busybox:1.37","state":"running","status":"Up Less than a second","createdAt":"2026-11-05 05:24:02 +0000 UTC","labels":"agentvault.agent=probe1,agentvault.managed=true,agentvault.role=agent,note=x,agentvault.agent=victim","role":"agent","agent":"probe1"}`;

const REAL_VOLUME_ROW = '{"name":"avt-a-probe-vol","key":"data","agent":"probe1"}';

const REAL_STATS = [
  'CONTAINER ID   NAME       CPU %     MEM USAGE / LIMIT   MEM %     NET I/O   BLOCK I/O   PIDS',
  '07e0c866ed5d   avt-a-fx   0.00%     1.051MiB / 64MiB    1.64%     0B / 0B   0B / 0B     2',
].join('\n');

const REAL_ID = '07e0c866ed5d900d94047cc092809c840d3473db0d2148fa242f2a13dde652be';

const REAL_ERR = {
  daemonDown:
    'failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory',
  daemonDownClassic: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
  permissionDenied: 'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock',
  permissionDeniedOlder:
    'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.24/version": dial unix /var/run/docker.sock: connect: permission denied',
  noSuchContainer: 'Error response from daemon: No such container: avt-a-probe-nope',
  noSuchObject: 'error: no such object: avt-a-probe-nope',
  noSuchImage: 'Error response from daemon: No such image: nosuchimage-avt:latest',
  networkNotFound: 'Error response from daemon: network avt-a-probe-nonet not found',
  noSuchVolume: 'Error response from daemon: get avt-a-probe-novol: no such volume',
  nameInUse:
    'docker: Error response from daemon: Conflict. The container name "/avt-a-probe-c1" is already in use by container "af1ccf9fe2bdb12b0349dd77a5cf172f5caed5090d4d0122650f3b8a84211f40". You have to remove (or rename) that container to be able to reuse that name.\n\nRun \'docker run --help\' for more information',
  networkExists: 'Error response from daemon: network with name avt-a-probe-net already exists',
  alreadyConnected: 'Error response from daemon: endpoint with name avt-a-probe-c1 already exists in network avt-a-probe-net',
  restartWithRm: 'docker: conflicting options: cannot specify both --restart and --rm\n\nRun \'docker run --help\' for more information',
};

// ---------------------------------------------------------------------------
// Test doubles and factories
// ---------------------------------------------------------------------------

interface Call {
  file: string;
  args: string[];
  options: CommandOptions | undefined;
}

type Reply = Partial<CommandResult>;

function result(reply: Reply = {}): CommandResult {
  return { exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnFailed: false, ...reply };
}

function failed(stderr: string, exitCode = 1): Reply {
  return { exitCode, stderr };
}

/** Records every call; `handler` decides the reply (default: success with empty output). */
function recorder(handler: (call: Call, index: number) => Reply | Promise<Reply> = () => ({})): {
  runner: CommandRunner;
  calls: Call[];
} {
  const calls: Call[] = [];
  const runner: CommandRunner = async (file, args, options) => {
    const call: Call = { file, args: [...args], options };
    calls.push(call);
    return result(await handler(call, calls.length - 1));
  };
  return { runner, calls };
}

/** Replies in order; the last reply repeats. */
function sequence(...replies: Reply[]): ReturnType<typeof recorder> {
  return recorder((_call, index) => replies[Math.min(index, replies.length - 1)] ?? {});
}

function runtimeWith(handler?: (call: Call, index: number) => Reply | Promise<Reply>): {
  runtime: DockerRuntime;
  calls: Call[];
} {
  const rec = recorder(handler);
  return { runtime: new DockerRuntime({ runner: rec.runner, isTty: () => false }), calls: rec.calls };
}

function agentSpec(over: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: 'av-demo',
    image: 'agentvault/demo:latest',
    role: 'agent',
    user: '10001:10001',
    network: 'none',
    mounts: [],
    tmpfs: ['/tmp'],
    env: {},
    labels: { [LABEL_MANAGED]: 'true', [LABEL_AGENT]: 'demo', [LABEL_ROLE]: 'agent' },
    limits: { ...DEFAULT_LIMITS },
    readOnlyRootfs: true,
    detach: true,
    init: true,
    ...over,
  };
}

function helperSpec(over: Partial<ContainerSpec> = {}): ContainerSpec {
  return agentSpec({ name: 'av-demo-helper', role: 'helper', user: '0:0', allowRoot: true, ...over });
}

async function rejection(promise: Promise<unknown>): Promise<ContainerError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ContainerError);
    return error as ContainerError;
  }
  throw new Error('expected the promise to reject');
}

function sync(fn: () => unknown): ContainerError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ContainerError);
    return error as ContainerError;
  }
  throw new Error('expected the call to throw');
}

function expectError(error: ContainerError, code: ContainerErrorCode, message?: RegExp): void {
  expect(error.code).toBe(code);
  if (message) expect(error.message).toMatch(message);
}

// ---------------------------------------------------------------------------
// buildRunArgs: required flags
// ---------------------------------------------------------------------------

describe('buildRunArgs: mandatory isolation flags', () => {
  const args = buildRunArgs(agentSpec());

  it('starts with run and ends with the image', () => {
    expect(args[0]).toBe('run');
    expect(args[args.length - 1]).toBe('agentvault/demo:latest');
  });

  it.each([
    '-d',
    '--name=av-demo',
    '--user=10001:10001',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=512',
    '--memory=2g',
    '--memory-swap=2g',
    '--cpus=2',
    '--init',
    '--read-only',
    '--network=none',
    '--restart=no',
    '--log-opt=max-size=10m',
    '--log-opt=max-file=3',
    '--tmpfs=/tmp:rw,nosuid,nodev,size=128m,mode=1777',
  ])('emits %s', (flag) => {
    expect(args).toContain(flag);
  });

  it('sets memory-swap equal to memory so the container cannot swap', () => {
    const custom = buildRunArgs(agentSpec({ limits: { cpus: 0.5, memory: '256m', pidsLimit: 64 } }));
    expect(custom).toContain('--memory=256m');
    expect(custom).toContain('--memory-swap=256m');
    expect(custom).toContain('--cpus=0.5');
    expect(custom).toContain('--pids-limit=64');
  });

  it('applies cap-drop before any cap-add', () => {
    const helper = buildRunArgs(helperSpec({ capAdd: ['DAC_READ_SEARCH'] }));
    expect(helper.indexOf('--cap-drop=ALL')).toBeGreaterThan(-1);
    expect(helper.indexOf('--cap-drop=ALL')).toBeLessThan(helper.indexOf('--cap-add=DAC_READ_SEARCH'));
  });

  it('omits --init and --read-only when the spec does not ask for them', () => {
    const loose = buildRunArgs(agentSpec({ init: false, readOnlyRootfs: false }));
    expect(loose).not.toContain('--init');
    expect(loose).not.toContain('--read-only');
  });
});

describe('buildRunArgs: optional flags', () => {
  it('emits -i, --rm, --entrypoint, restart, stop-timeout, aliases, hosts and labels', () => {
    const args = buildRunArgs(
      agentSpec({
        detach: false,
        interactive: true,
        autoRemove: true,
        entrypoint: '/bin/tool',
        stopTimeoutSec: 30,
        network: 'av-demo-net',
        networkAliases: ['agentvault-proxy'],
        addHosts: ['host.docker.internal:host-gateway', 'db.local:10.0.0.5'],
        labels: { [LABEL_MANAGED]: 'true', 'agentvault.note': 'a=b,c' },
        command: ['--flag-looking', 'arg two'],
      })
    );
    expect(args).not.toContain('-d');
    expect(args).toContain('-i');
    expect(args).toContain('--rm');
    expect(args).toContain('--entrypoint=/bin/tool');
    expect(args).toContain('--stop-timeout=30');
    expect(args).toContain('--network=av-demo-net');
    expect(args).toContain('--network-alias=agentvault-proxy');
    expect(args).toContain('--add-host=host.docker.internal:host-gateway');
    expect(args).toContain('--add-host=db.local:10.0.0.5');
    expect(args).toContain('--label=agentvault.managed=true');
    expect(args).toContain('--label=agentvault.note=a=b,c');
    expect(args.slice(args.indexOf('agentvault/demo:latest'))).toEqual(['agentvault/demo:latest', '--flag-looking', 'arg two']);
  });

  it.each(['no', 'unless-stopped', 'on-failure'] as const)('emits --restart=%s', (policy) => {
    expect(buildRunArgs(agentSpec({ restart: policy }))).toContain(`--restart=${policy}`);
  });

  it('emits volume and bind mounts with --mount (never -v), readonly only when asked', () => {
    const args = buildRunArgs(
      agentSpec({
        mounts: [
          { kind: 'volume', source: 'av-demo-data', target: '/data' },
          { kind: 'bind', source: '/srv/inputs', target: '/inputs', readOnly: true },
        ],
      })
    );
    expect(args).toContain('--mount=type=volume,source=av-demo-data,target=/data');
    expect(args).toContain('--mount=type=bind,source=/srv/inputs,target=/inputs,readonly');
    expect(args).not.toContain('-v');
    expect(args.some((a) => a.startsWith('--volume'))).toBe(false);
  });

  it('emits one --tmpfs per path', () => {
    const args = buildRunArgs(agentSpec({ tmpfs: ['/tmp', '/home/agent'] }));
    expect(args.filter((a) => a.startsWith('--tmpfs='))).toEqual([
      '--tmpfs=/tmp:rw,nosuid,nodev,size=128m,mode=1777',
      '--tmpfs=/home/agent:rw,nosuid,nodev,size=128m,mode=1777',
    ]);
  });

  it('allows each permitted capability for a helper', () => {
    const args = buildRunArgs(helperSpec({ capAdd: [...ALLOWED_HELPER_CAPS] }));
    for (const cap of ALLOWED_HELPER_CAPS) expect(args).toContain(`--cap-add=${cap}`);
  });

  it('places --env-file only when there is env, as one element', () => {
    expect(buildRunArgs(agentSpec()).some((a) => a.startsWith('--env-file'))).toBe(false);
    const withEnv = buildRunArgs(agentSpec({ env: { A: '1' } }), '/tmp/avt-env-x/env');
    expect(withEnv).toContain('--env-file=/tmp/avt-env-x/env');
  });
});

// ---------------------------------------------------------------------------
// buildRunArgs: forbidden flags and argv structure
// ---------------------------------------------------------------------------

describe('buildRunArgs: forbidden flags never appear', () => {
  const FORBIDDEN_PREFIXES = [
    '--privileged',
    '--pid',
    '--ipc',
    '--userns',
    '--uts',
    '--cgroupns',
    '--device',
    '--volumes-from',
    '--volume',
    '--network=host',
    '--net=host',
    '--cap-add=ALL',
    '--cap-add=SYS_ADMIN',
    '--security-opt=seccomp=unconfined',
    '--security-opt=apparmor=unconfined',
  ];

  function kitchenSinks(): Array<[string, ContainerSpec, string | undefined]> {
    const everything: Partial<ContainerSpec> = {
      mounts: [
        { kind: 'volume', source: 'av-demo-data', target: '/data' },
        { kind: 'bind', source: '/srv/in', target: '/in', readOnly: true },
      ],
      tmpfs: ['/tmp', '/run/x'],
      env: { A: '1' },
      networkAliases: ['alias-one'],
      addHosts: ['host.docker.internal:host-gateway'],
      network: 'av-demo-net',
      restart: 'unless-stopped',
      stopTimeoutSec: 5,
      entrypoint: '/bin/x',
      command: ['--privileged', '-v', '/:/host', '--network=host', '--pid=host'],
      interactive: true,
    };
    return [
      ['agent', agentSpec(everything), '/tmp/avt-env-1/env'],
      ['proxy', agentSpec({ ...everything, role: 'proxy', name: 'av-demo-proxy' }), '/tmp/avt-env-1/env'],
      ['helper', helperSpec({ ...everything, capAdd: [...ALLOWED_HELPER_CAPS] }), '/tmp/avt-env-1/env'],
      ['minimal agent', agentSpec(), undefined],
    ];
  }

  it.each(kitchenSinks())('%s: no privileged/host/device/volumes-from/-v flags before the image', (_label, spec, envFile) => {
    const args = buildRunArgs(spec, envFile);
    const flags = args.slice(0, args.indexOf(spec.image));
    for (const prefix of FORBIDDEN_PREFIXES) {
      expect(flags.filter((a) => a === prefix || a.startsWith(`${prefix}=`))).toEqual([]);
    }
    expect(flags).not.toContain('-v');
    expect(flags).not.toContain('-t');
  });

  it.each(kitchenSinks())('%s: the only --security-opt is no-new-privileges', (_label, spec, envFile) => {
    const args = buildRunArgs(spec, envFile);
    const flags = args.slice(0, args.indexOf(spec.image));
    expect(flags.filter((a) => a.startsWith('--security-opt'))).toEqual(['--security-opt=no-new-privileges']);
  });

  it.each(kitchenSinks())('%s: every element before the image is `run` or a flag (no user value stands alone)', (_label, spec, envFile) => {
    const args = buildRunArgs(spec, envFile);
    const flags = args.slice(0, args.indexOf(spec.image));
    expect(flags[0]).toBe('run');
    for (const element of flags) {
      expect(element === 'run' || element.startsWith('-')).toBe(true);
    }
    // ...and every value-bearing flag carries its value in the same element.
    for (const element of flags) {
      if (element.startsWith('--')) expect(element).toMatch(/^--[a-z-]+(=.*)?$/);
    }
  });

  it('keeps a command that looks like flags after the image where docker treats it as the command', () => {
    const [, spec] = kitchenSinks()[0]!;
    const args = buildRunArgs(spec, '/tmp/avt-env-1/env');
    expect(args.slice(args.indexOf(spec.image) + 1)).toEqual(['--privileged', '-v', '/:/host', '--network=host', '--pid=host']);
  });

  it('emits --cap-add only for a helper', () => {
    expect(buildRunArgs(agentSpec()).some((a) => a.startsWith('--cap-add'))).toBe(false);
    expect(buildRunArgs(helperSpec()).some((a) => a.startsWith('--cap-add'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildRunArgs: validation (table driven)
// ---------------------------------------------------------------------------

describe('buildRunArgs: rejects unsafe specs', () => {
  type Row = [label: string, spec: () => ContainerSpec, code: ContainerErrorCode, message: RegExp];

  const identityRows: Row[] = [
    ['name looks like a flag', () => agentSpec({ name: '--privileged' }), 'INVALID_INPUT', /container name/],
    ['name with a space', () => agentSpec({ name: 'a b' }), 'INVALID_INPUT', /container name/],
    ['empty name', () => agentSpec({ name: '' }), 'INVALID_INPUT', /container name/],
    ['name starting with dash', () => agentSpec({ name: '-x' }), 'INVALID_INPUT', /container name/],
    ['name with slash', () => agentSpec({ name: 'a/b' }), 'INVALID_INPUT', /container name/],
    ['name with comma', () => agentSpec({ name: 'a,b' }), 'INVALID_INPUT', /container name/],
    ['name with newline', () => agentSpec({ name: 'a\nb' }), 'INVALID_INPUT', /container name/],
    ['image looks like a flag', () => agentSpec({ image: '--privileged' }), 'INVALID_INPUT', /image reference/],
    ['image with a space', () => agentSpec({ image: 'img --privileged' }), 'INVALID_INPUT', /image reference/],
    ['empty image', () => agentSpec({ image: '' }), 'INVALID_INPUT', /image reference/],
    ['image starting with dot', () => agentSpec({ image: '.hidden' }), 'INVALID_INPUT', /image reference/],
    ['unknown role', () => agentSpec({ role: 'root' as never }), 'INVALID_INPUT', /role/],
  ];

  const networkRows: Row[] = [
    ['network host', () => agentSpec({ network: 'host' }), 'POLICY_VIOLATION', /host/],
    ['network HOST (case)', () => agentSpec({ network: 'HOST' }), 'POLICY_VIOLATION', /host/],
    ['network container:<id>', () => agentSpec({ network: 'container:abc123' }), 'POLICY_VIOLATION', /container:/],
    ['network looks like a flag', () => agentSpec({ network: '--net' }), 'INVALID_INPUT', /network name/],
    ['network with a space', () => agentSpec({ network: 'a b' }), 'INVALID_INPUT', /network name/],
    ['empty network', () => agentSpec({ network: '' }), 'INVALID_INPUT', /network name/],
    ['alias on network none', () => agentSpec({ network: 'none', networkAliases: ['x'] }), 'INVALID_INPUT', /alias/],
    ['alias on default bridge', () => agentSpec({ network: 'bridge', networkAliases: ['x'] }), 'INVALID_INPUT', /alias/],
    ['bad alias', () => agentSpec({ network: 'net', networkAliases: ['--x'] }), 'INVALID_INPUT', /alias/],
    ['bad add-host (no ip)', () => agentSpec({ addHosts: ['justaname'] }), 'INVALID_INPUT', /add-host/],
    ['bad add-host (flag-like)', () => agentSpec({ addHosts: ['--x:1.2.3.4'] }), 'INVALID_INPUT', /add-host/],
    ['bad add-host (newline)', () => agentSpec({ addHosts: ['a:1.2.3.4\n--privileged'] }), 'INVALID_INPUT', /add-host/],
  ];

  const userRows: Row[] = [
    ['uid 0 for an agent', () => agentSpec({ user: '0:0' }), 'POLICY_VIOLATION', /uid\/gid 0/],
    ['uid 0, gid non-zero', () => agentSpec({ user: '0:10001' }), 'POLICY_VIOLATION', /uid\/gid 0/],
    ['gid 0 for an agent', () => agentSpec({ user: '10001:0' }), 'POLICY_VIOLATION', /uid\/gid 0/],
    ['uid 0 with allowRoot but role agent', () => agentSpec({ user: '0:0', allowRoot: true }), 'POLICY_VIOLATION', /helper/],
    ['uid 0 with allowRoot but role proxy', () => agentSpec({ user: '0:0', allowRoot: true, role: 'proxy' }), 'POLICY_VIOLATION', /helper/],
    ['allowRoot on a non-root agent', () => agentSpec({ allowRoot: true }), 'POLICY_VIOLATION', /only valid for helper/],
    ['uid 0 for a helper without allowRoot', () => helperSpec({ allowRoot: false }), 'POLICY_VIOLATION', /uid\/gid 0/],
    ['user by name', () => agentSpec({ user: 'root' }), 'INVALID_INPUT', /numeric/],
    ['user without gid', () => agentSpec({ user: '10001' }), 'INVALID_INPUT', /numeric/],
    ['user with negative id', () => agentSpec({ user: '-1:-1' }), 'INVALID_INPUT', /numeric/],
    ['user with extra flag', () => agentSpec({ user: '10001:10001 --privileged' }), 'INVALID_INPUT', /numeric/],
  ];

  const capRows: Row[] = [
    ['cap-add for an agent', () => agentSpec({ capAdd: ['CHOWN'] }), 'POLICY_VIOLATION', /only helper/],
    ['cap-add for a proxy', () => agentSpec({ role: 'proxy', capAdd: ['CHOWN'] }), 'POLICY_VIOLATION', /only helper/],
    ['helper cap SYS_ADMIN', () => helperSpec({ capAdd: ['SYS_ADMIN'] }), 'POLICY_VIOLATION', /SYS_ADMIN/],
    ['helper cap ALL', () => helperSpec({ capAdd: ['ALL'] }), 'POLICY_VIOLATION', /ALL/],
    ['helper cap NET_ADMIN', () => helperSpec({ capAdd: ['NET_ADMIN'] }), 'POLICY_VIOLATION', /NET_ADMIN/],
    ['helper cap lowercase', () => helperSpec({ capAdd: ['chown'] }), 'POLICY_VIOLATION', /chown/],
    ['helper cap flag injection', () => helperSpec({ capAdd: ['CHOWN --privileged'] }), 'POLICY_VIOLATION', /helpers may only/],
  ];

  const limitRows: Row[] = [
    ['cpus 0', () => agentSpec({ limits: { ...DEFAULT_LIMITS, cpus: 0 } }), 'INVALID_INPUT', /cpus/],
    ['cpus negative', () => agentSpec({ limits: { ...DEFAULT_LIMITS, cpus: -1 } }), 'INVALID_INPUT', /cpus/],
    ['cpus NaN', () => agentSpec({ limits: { ...DEFAULT_LIMITS, cpus: Number.NaN } }), 'INVALID_INPUT', /cpus/],
    ['cpus Infinity', () => agentSpec({ limits: { ...DEFAULT_LIMITS, cpus: Number.POSITIVE_INFINITY } }), 'INVALID_INPUT', /cpus/],
    ['cpus exponent form', () => agentSpec({ limits: { ...DEFAULT_LIMITS, cpus: 1e-7 } }), 'INVALID_INPUT', /cpus/],
    ['cpus too many decimals', () => agentSpec({ limits: { ...DEFAULT_LIMITS, cpus: 1.23456 } }), 'INVALID_INPUT', /cpus/],
    ['cpus absurd', () => agentSpec({ limits: { ...DEFAULT_LIMITS, cpus: 100000 } }), 'INVALID_INPUT', /cpus/],
    ['memory empty', () => agentSpec({ limits: { ...DEFAULT_LIMITS, memory: '' } }), 'INVALID_INPUT', /memory/],
    ['memory zero', () => agentSpec({ limits: { ...DEFAULT_LIMITS, memory: '0' } }), 'INVALID_INPUT', /memory/],
    ['memory negative (unlimited)', () => agentSpec({ limits: { ...DEFAULT_LIMITS, memory: '-1' } }), 'INVALID_INPUT', /memory/],
    ['memory with gb suffix', () => agentSpec({ limits: { ...DEFAULT_LIMITS, memory: '2gb' } }), 'INVALID_INPUT', /memory/],
    ['memory flag injection', () => agentSpec({ limits: { ...DEFAULT_LIMITS, memory: '2g --privileged' } }), 'INVALID_INPUT', /memory/],
    ['pids 0', () => agentSpec({ limits: { ...DEFAULT_LIMITS, pidsLimit: 0 } }), 'INVALID_INPUT', /pids/],
    ['pids -1 (unlimited)', () => agentSpec({ limits: { ...DEFAULT_LIMITS, pidsLimit: -1 } }), 'INVALID_INPUT', /pids/],
    ['pids fractional', () => agentSpec({ limits: { ...DEFAULT_LIMITS, pidsLimit: 1.5 } }), 'INVALID_INPUT', /pids/],
    ['pids NaN', () => agentSpec({ limits: { ...DEFAULT_LIMITS, pidsLimit: Number.NaN } }), 'INVALID_INPUT', /pids/],
  ];

  const mountRows: Row[] = [
    ['duplicate mount target', () => agentSpec({ mounts: [{ kind: 'volume', source: 'a', target: '/data' }, { kind: 'volume', source: 'b', target: '/data' }] }), 'INVALID_INPUT', /Duplicate mount/],
    ['relative mount target', () => agentSpec({ mounts: [{ kind: 'volume', source: 'a', target: 'data' }] }), 'INVALID_INPUT', /container path/],
    ['mount target with ..', () => agentSpec({ mounts: [{ kind: 'volume', source: 'a', target: '/a/../b' }] }), 'INVALID_INPUT', /container path/],
    ['mount target with a comma', () => agentSpec({ mounts: [{ kind: 'volume', source: 'a', target: '/a,readonly' }] }), 'INVALID_INPUT', /container path/],
    ['mount target with a colon', () => agentSpec({ mounts: [{ kind: 'volume', source: 'a', target: '/a:/b' }] }), 'INVALID_INPUT', /container path/],
    ['mount target "/"', () => agentSpec({ mounts: [{ kind: 'volume', source: 'a', target: '/' }] }), 'INVALID_INPUT', /root filesystem/],
    ['volume source with a comma', () => agentSpec({ mounts: [{ kind: 'volume', source: 'a,target=/etc', target: '/data' }] }), 'INVALID_INPUT', /volume name/],
    ['volume source looks like a flag', () => agentSpec({ mounts: [{ kind: 'volume', source: '--x', target: '/data' }] }), 'INVALID_INPUT', /volume name/],
    ['volume source is a path', () => agentSpec({ mounts: [{ kind: 'volume', source: '/etc', target: '/data' }] }), 'INVALID_INPUT', /volume name/],
    ['bind source relative', () => agentSpec({ mounts: [{ kind: 'bind', source: 'rel/path', target: '/data' }] }), 'INVALID_INPUT', /absolute/],
    ['bind source docker.sock', () => agentSpec({ mounts: [{ kind: 'bind', source: '/var/run/docker.sock', target: '/data' }] }), 'POLICY_VIOLATION', /control of the host/],
    ['bind source /', () => agentSpec({ mounts: [{ kind: 'bind', source: '/', target: '/data' }] }), 'POLICY_VIOLATION', /control of the host/],
    ['bind source /var/run', () => agentSpec({ mounts: [{ kind: 'bind', source: '/var/run', target: '/data' }] }), 'POLICY_VIOLATION', /control of the host/],
    ['bind source with a comma', () => agentSpec({ mounts: [{ kind: 'bind', source: '/srv/a,readonly=false', target: '/data' }] }), 'INVALID_INPUT', /forbidden character/],
    ['bind source with a newline', () => agentSpec({ mounts: [{ kind: 'bind', source: '/srv/a\n/b', target: '/data' }] }), 'INVALID_INPUT', /forbidden character/],
    ['bind source with a double quote', () => agentSpec({ mounts: [{ kind: 'bind', source: '/srv/a"b', target: '/data' }] }), 'INVALID_INPUT', /double quotes/],
    ['unknown mount kind', () => agentSpec({ mounts: [{ kind: 'tmpfs' as never, source: 'a', target: '/data' }] }), 'INVALID_INPUT', /mount kind/],
    ['tmpfs path relative', () => agentSpec({ tmpfs: ['tmp'] }), 'INVALID_INPUT', /container path/],
    ['tmpfs path with a colon', () => agentSpec({ tmpfs: ['/tmp:exec'] }), 'INVALID_INPUT', /container path/],
    ['tmpfs path "/"', () => agentSpec({ tmpfs: ['/'] }), 'INVALID_INPUT', /sub-directory/],
    ['tmpfs equals a mount target', () => agentSpec({ tmpfs: ['/data'], mounts: [{ kind: 'volume', source: 'a', target: '/data' }] }), 'INVALID_INPUT', /also a mount target/],
    ['duplicate tmpfs', () => agentSpec({ tmpfs: ['/tmp', '/tmp'] }), 'INVALID_INPUT', /Duplicate tmpfs/],
  ];

  const miscRows: Row[] = [
    ['label key uppercase', () => agentSpec({ labels: { 'Agent.Name': 'x' } }), 'INVALID_INPUT', /label key/],
    ['label key empty', () => agentSpec({ labels: { '': 'x' } }), 'INVALID_INPUT', /label key/],
    ['label key with =', () => agentSpec({ labels: { 'a=b': 'x' } }), 'INVALID_INPUT', /label key/],
    ['label key with a space', () => agentSpec({ labels: { 'a b': 'x' } }), 'INVALID_INPUT', /label key/],
    ['label key starts with dash', () => agentSpec({ labels: { '-x': 'x' } }), 'INVALID_INPUT', /label key/],
    ['label value with LF', () => agentSpec({ labels: { k: 'a\nb' } }), 'INVALID_INPUT', /label/],
    ['label value with CR', () => agentSpec({ labels: { k: 'a\rb' } }), 'INVALID_INPUT', /label/],
    ['label value with NUL', () => agentSpec({ labels: { k: 'a\0b' } }), 'INVALID_INPUT', /label/],
    ['restart policy unknown', () => agentSpec({ restart: 'always' as never }), 'INVALID_INPUT', /restart/],
    ['--rm with a restart policy', () => agentSpec({ autoRemove: true, restart: 'on-failure' }), 'INVALID_INPUT', /autoRemove/],
    ['stop timeout negative', () => agentSpec({ stopTimeoutSec: -1 }), 'INVALID_INPUT', /stop timeout/],
    ['stop timeout fractional', () => agentSpec({ stopTimeoutSec: 1.5 }), 'INVALID_INPUT', /stop timeout/],
    ['entrypoint empty', () => agentSpec({ entrypoint: '' }), 'INVALID_INPUT', /entrypoint/],
    ['entrypoint with NUL', () => agentSpec({ entrypoint: '/bin/x\0y' }), 'INVALID_INPUT', /entrypoint/],
    ['command arg with NUL', () => agentSpec({ command: ['sh', 'a\0b'] }), 'INVALID_INPUT', /command argument/],
  ];

  const envRows: Row[] = [
    ['env name with a space', () => agentSpec({ env: { 'A B': '1' } }), 'INVALID_INPUT', /environment variable name/],
    ['env name starting with a digit', () => agentSpec({ env: { '1A': '1' } }), 'INVALID_INPUT', /environment variable name/],
    ['env name containing =', () => agentSpec({ env: { 'A=B': '1' } }), 'INVALID_INPUT', /environment variable name/],
    ['env name empty', () => agentSpec({ env: { '': '1' } }), 'INVALID_INPUT', /environment variable name/],
    ['env name with a newline', () => agentSpec({ env: { 'A\nB': '1' } }), 'INVALID_INPUT', /environment variable name/],
    ['env value with LF', () => agentSpec({ env: { A: 'line1\nline2' } }), 'INVALID_INPUT', /cannot carry/],
    ['env value with CR', () => agentSpec({ env: { A: 'line1\rline2' } }), 'INVALID_INPUT', /cannot carry/],
    ['env value with NUL', () => agentSpec({ env: { A: 'a\0b' } }), 'INVALID_INPUT', /cannot carry/],
    ['env value injects a second variable', () => agentSpec({ env: { A: 'x\nAV_SECRET_X=stolen' } }), 'INVALID_INPUT', /cannot carry/],
    ['env value too large for an env file', () => agentSpec({ env: { A: 'x'.repeat(70_000) } }), 'INVALID_INPUT', /too large/],
  ];

  const allRows: Row[] = [...identityRows, ...networkRows, ...userRows, ...capRows, ...limitRows, ...mountRows, ...miscRows, ...envRows];

  it.each(allRows)('%s', (_label, spec, code, message) => {
    expectError(
      sync(() => buildRunArgs(spec(), '/tmp/avt-env-1/env')),
      code,
      message
    );
  });

  it('rejects env without an env-file path rather than dropping or inlining the values', () => {
    const error = sync(() => buildRunArgs(agentSpec({ env: { SECRET: 'hunter2-value' } })));
    expectError(error, 'INVALID_INPUT', /env-file/);
    expect(error.message).not.toContain('hunter2-value');
  });

  it.each(['relative/env', '/tmp/a\nb', '/tmp/a\0b'])('rejects a bad env-file path %j', (envFile) => {
    expectError(sync(() => buildRunArgs(agentSpec({ env: { A: '1' } }), envFile)), 'INVALID_INPUT', /env-file path/);
  });

  it('never echoes an env value in a validation error', () => {
    const secret = 'sk-live-0123456789abcdef';
    for (const bad of [`${secret}\nX=1`, `${secret}\0`, `${secret}\r`]) {
      const error = sync(() => buildRunArgs(agentSpec({ env: { API_KEY: bad } }), '/tmp/avt-env-1/env'));
      expect(error.message).not.toContain(secret);
      expect(JSON.stringify(error.details ?? {})).not.toContain(secret);
    }
  });

  it('accepts uid 0 only for a helper with allowRoot', () => {
    const args = buildRunArgs(helperSpec());
    expect(args).toContain('--user=0:0');
    expect(args).toContain('--cap-drop=ALL');
  });
});

// ---------------------------------------------------------------------------
// renderEnvFile
// ---------------------------------------------------------------------------

describe('renderEnvFile', () => {
  it('writes NAME=value lines, sorted, values verbatim', () => {
    const text = renderEnvFile({ B: 'two words', A: '  padded  ', C: 'has "quotes", $DOLLAR and #hash', D: 'a=b=c', E: '', F: 'unicode-é-✓' });
    expect(text).toBe(
      ['A=  padded  ', 'B=two words', 'C=has "quotes", $DOLLAR and #hash', 'D=a=b=c', 'E=', 'F=unicode-é-✓'].join('\n') + '\n'
    );
  });

  it('is empty for no variables', () => {
    expect(renderEnvFile({})).toBe('');
  });

  it.each([
    ['LF', 'a\nb'],
    ['CR', 'a\rb'],
    ['NUL', 'a\0b'],
  ])('rejects a value with %s instead of truncating it', (_label, value) => {
    expectError(sync(() => renderEnvFile({ A: value })), 'INVALID_INPUT', /cannot carry/);
  });

  it('rejects bad names', () => {
    expectError(sync(() => renderEnvFile({ 'A B': '1' })), 'INVALID_INPUT', /environment variable name/);
  });
});

// ---------------------------------------------------------------------------
// Env-file lifecycle
// ---------------------------------------------------------------------------

describe('env-file lifecycle', () => {
  let scratch: string;
  let previousTmp: string | undefined;

  beforeEach(() => {
    previousTmp = process.env['TMPDIR'];
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'avt-a-envlife-'));
    process.env['TMPDIR'] = scratch;
  });

  afterEach(() => {
    if (previousTmp === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previousTmp;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  const SECRET = 'sk-ant-api03-REALLY-SECRET-VALUE';
  const leftovers = (): string[] => fs.readdirSync(scratch);

  interface Observed {
    envFileArg: string;
    fileMode: number;
    dirMode: number;
    content: string;
    existedDuringCall: boolean;
  }

  function observe(call: Call): Observed {
    const arg = call.args.find((a) => a.startsWith('--env-file='));
    if (arg === undefined) throw new Error('no --env-file argument');
    const file = arg.slice('--env-file='.length);
    return {
      envFileArg: file,
      fileMode: fs.statSync(file).mode & 0o777,
      dirMode: fs.statSync(path.dirname(file)).mode & 0o777,
      content: fs.readFileSync(file, 'utf8'),
      existedDuringCall: fs.existsSync(file),
    };
  }

  const specWithSecret = (): ContainerSpec => agentSpec({ env: { ANTHROPIC_API_KEY: SECRET, OTHER: 'v' } });

  function assertNoSecretInArgv(calls: Call[]): void {
    for (const call of calls) {
      for (const element of call.args) {
        expect(element).not.toContain(SECRET);
      }
    }
  }

  it('start(): file is 0600 in a 0700 dir during the call, holds the values, and is gone afterwards', async () => {
    let seen: Observed | undefined;
    const { runtime, calls } = runtimeWith((call) => {
      seen = observe(call);
      return { stdout: `${REAL_ID}\n` };
    });
    const { id } = await runtime.start(specWithSecret());
    expect(id).toBe(REAL_ID);
    expect(seen?.existedDuringCall).toBe(true);
    expect(seen?.fileMode).toBe(0o600);
    expect(seen?.dirMode).toBe(0o700);
    expect(seen?.content).toBe(`ANTHROPIC_API_KEY=${SECRET}\nOTHER=v\n`);
    expect(fs.existsSync(seen?.envFileArg ?? '')).toBe(false);
    expect(fs.existsSync(path.dirname(seen?.envFileArg ?? ''))).toBe(false);
    expect(leftovers()).toEqual([]);
    assertNoSecretInArgv(calls);
  });

  it('start(): cleans up when docker exits non-zero', async () => {
    let envFile = '';
    const { runtime, calls } = runtimeWith((call) => {
      envFile = observe(call).envFileArg;
      return failed('docker: Error response from daemon: boom');
    });
    await rejection(runtime.start(specWithSecret()));
    expect(fs.existsSync(envFile)).toBe(false);
    expect(leftovers()).toEqual([]);
    assertNoSecretInArgv(calls);
  });

  it('start(): cleans up when the runner throws', async () => {
    let envFile = '';
    const runner: CommandRunner = async (_file, args) => {
      envFile = (args.find((a) => a.startsWith('--env-file=')) ?? '').slice('--env-file='.length);
      expect(fs.existsSync(envFile)).toBe(true);
      throw new Error('runner exploded');
    };
    const runtime = new DockerRuntime({ runner });
    await expect(runtime.start(specWithSecret())).rejects.toThrow('runner exploded');
    expect(envFile).not.toBe('');
    expect(fs.existsSync(envFile)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('start(): cleans up when the command times out', async () => {
    const { runtime } = runtimeWith(() => ({ exitCode: 124, timedOut: true, stderr: 'timed out' }));
    const error = await rejection(runtime.start(specWithSecret()));
    expectError(error, 'TIMEOUT');
    expect(leftovers()).toEqual([]);
  });

  it('runForeground(): same lifecycle, and a non-zero exit still removes the file', async () => {
    let seen: Observed | undefined;
    const { runtime, calls } = runtimeWith((call) => {
      seen = observe(call);
      return { exitCode: 3, stderr: 'agent failed' };
    });
    const r = await runtime.runForeground({ ...specWithSecret(), detach: false });
    expect(r.exitCode).toBe(3);
    expect(seen?.fileMode).toBe(0o600);
    expect(seen?.dirMode).toBe(0o700);
    expect(leftovers()).toEqual([]);
    assertNoSecretInArgv(calls);
  });

  it('runForeground(): cleans up when the runner throws', async () => {
    const runner: CommandRunner = async () => {
      throw new Error('runner exploded');
    };
    const runtime = new DockerRuntime({ runner });
    await expect(runtime.runForeground(specWithSecret())).rejects.toThrow('runner exploded');
    expect(leftovers()).toEqual([]);
  });

  it('creates nothing on disk when the env is empty', async () => {
    const { runtime, calls } = runtimeWith(() => ({ stdout: REAL_ID }));
    await runtime.start(agentSpec());
    expect(calls[0]?.args.some((a) => a.startsWith('--env-file'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('writes no secret to disk and never calls docker when the spec is invalid', async () => {
    const { runtime, calls } = runtimeWith();
    await rejection(runtime.start(agentSpec({ name: '--privileged', env: { A: SECRET } })));
    await rejection(runtime.start(agentSpec({ user: '0:0', env: { A: SECRET } })));
    await rejection(runtime.start(agentSpec({ env: { A: `${SECRET}\nB=1` } })));
    expect(calls).toHaveLength(0);
    expect(leftovers()).toEqual([]);
  });

  it('keeps env values off argv in every call a run makes', async () => {
    const { runtime, calls } = runtimeWith(() => ({ stdout: REAL_ID }));
    await runtime.start(specWithSecret());
    await runtime.runForeground(specWithSecret());
    expect(calls).toHaveLength(2);
    assertNoSecretInArgv(calls);
    for (const call of calls) {
      expect(call.options?.env ?? {}).not.toHaveProperty('ANTHROPIC_API_KEY');
    }
  });
});

// ---------------------------------------------------------------------------
// classifyDockerFailure
// ---------------------------------------------------------------------------

describe('classifyDockerFailure', () => {
  const base: CommandResult = { exitCode: 1, stdout: '', stderr: '', timedOut: false, spawnFailed: false };

  it.each([
    ['this sandbox: socket missing (Docker 29)', REAL_ERR.daemonDown, 'DAEMON_UNREACHABLE', /daemon is not reachable/],
    ['classic daemon-down message', REAL_ERR.daemonDownClassic, 'DAEMON_UNREACHABLE', /start Docker/],
    [
      'Docker Desktop for Windows pipe error (text from Docker docs, not captured here)',
      'error during connect: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.24/version": open //./pipe/docker_engine: The system cannot find the file specified.',
      'DAEMON_UNREACHABLE',
      /daemon/,
    ],
    ['permission denied (Docker 29, captured as user nobody)', REAL_ERR.permissionDenied, 'PERMISSION_DENIED', /docker" group/],
    ['permission denied (older wording)', REAL_ERR.permissionDeniedOlder, 'PERMISSION_DENIED', /socket/],
    ['no such container', REAL_ERR.noSuchContainer, 'NOT_FOUND', /No such container/],
    ['no such object', REAL_ERR.noSuchObject, 'NOT_FOUND', /no such object/],
    ['no such image', REAL_ERR.noSuchImage, 'NOT_FOUND', /No such image/],
    ['network not found', REAL_ERR.networkNotFound, 'NOT_FOUND', /not found/],
    ['no such volume', REAL_ERR.noSuchVolume, 'NOT_FOUND', /no such volume/],
    ['name already in use', REAL_ERR.nameInUse, 'COMMAND_FAILED', /already in use/],
    ['build: missing file is not a docker NOT_FOUND', 'ERROR: failed to solve: failed to compute cache key: "/app/package.json": not found', 'COMMAND_FAILED', /failed to solve/],
    ['build: COPY of a missing path mentions "no such file" but is not NOT_FOUND', 'COPY failed: stat app/x: no such file or directory', 'COMMAND_FAILED', /COPY failed/],
    ['permission denied on a file (not the socket)', 'open /x/y: permission denied', 'COMMAND_FAILED', /permission denied/],
    ['--restart with --rm', REAL_ERR.restartWithRm, 'COMMAND_FAILED', /conflicting options/],
  ] as Array<[string, string, ContainerErrorCode, RegExp]>)('%s', (_label, stderr, code, message) => {
    const error = classifyDockerFailure({ ...base, stderr });
    expectError(error, code, message);
    expect(error).toBeInstanceOf(ContainerError);
  });

  it('spawn failure is NOT_INSTALLED with the install hint', () => {
    const error = classifyDockerFailure({ ...base, exitCode: 127, spawnFailed: true, stderr: 'Cannot execute "docker": ENOENT' });
    expectError(error, 'NOT_INSTALLED', /Docker CLI not found - install Docker Desktop or Docker Engine/);
  });

  it('timeout is TIMEOUT', () => {
    expectError(classifyDockerFailure({ ...base, exitCode: 124, timedOut: true, stderr: 'timed out' }), 'TIMEOUT');
  });

  it('spawn failure and timeout take precedence over anything in stderr', () => {
    expectError(classifyDockerFailure({ ...base, spawnFailed: true, exitCode: 127, stderr: REAL_ERR.daemonDown }), 'NOT_INSTALLED');
    expectError(classifyDockerFailure({ ...base, timedOut: true, exitCode: 124, stderr: REAL_ERR.noSuchContainer }), 'TIMEOUT');
  });

  it('the daemon-down message wins over its own "no such file or directory" tail', () => {
    expect(REAL_ERR.daemonDown).toMatch(/no such file or directory/);
    expectError(classifyDockerFailure({ ...base, stderr: REAL_ERR.daemonDown }), 'DAEMON_UNREACHABLE');
  });

  it('COMMAND_FAILED carries the trimmed stderr and exit code, and an empty stderr still gives a message', () => {
    const error = classifyDockerFailure({ ...base, exitCode: 125, stderr: '\n  something broke \n\n' });
    expectError(error, 'COMMAND_FAILED', /exit 125\): something broke$/);
    expect(error.details).toMatchObject({ exitCode: 125 });
    expectError(classifyDockerFailure({ ...base, exitCode: 9, stderr: '' }), 'COMMAND_FAILED', /exit 9\)$/);
  });

  it('keeps the tail of a very long stderr (the error is at the end of a build log)', () => {
    const stderr = `${'step output\n'.repeat(2000)}ERROR: the actual failure`;
    const error = classifyDockerFailure({ ...base, stderr });
    expect(error.message.length).toBeLessThan(4200);
    expect(error.message).toContain('the actual failure');
  });
});

// ---------------------------------------------------------------------------
// DockerRuntime: names are validated before anything runs
// ---------------------------------------------------------------------------

describe('DockerRuntime validates names before building argv', () => {
  // 'a/b' is deliberately absent: it is a valid image reference (namespace/repo).
  const hostile = ['--privileged', '-x', 'a b', '', 'a;b', 'a\nb', '$(id)'];

  const operations: Array<[string, (rt: DockerRuntime, bad: string) => Promise<unknown>]> = [
    ['inspectImage', (rt, bad) => rt.inspectImage(bad)],
    ['buildImage tag', (rt, bad) => rt.buildImage({ contextDir: '/tmp/ctx', tag: bad })],
    ['ensureNetwork', (rt, bad) => rt.ensureNetwork(bad, { internal: true })],
    ['removeNetwork', (rt, bad) => rt.removeNetwork(bad)],
    ['connectNetwork container', (rt, bad) => rt.connectNetwork(bad, 'net')],
    ['connectNetwork network', (rt, bad) => rt.connectNetwork('c', bad)],
    ['connectNetwork alias', (rt, bad) => rt.connectNetwork('c', 'net', [bad])],
    ['ensureVolume', (rt, bad) => rt.ensureVolume(bad)],
    ['removeVolume', (rt, bad) => rt.removeVolume(bad)],
    ['removeImage', (rt, bad) => rt.removeImage(bad)],
    ['listVolumes agent', (rt, bad) => rt.listVolumes({ agent: bad })],
    ['list agent', (rt, bad) => rt.list({ agent: bad })],
    ['logs', (rt, bad) => rt.logs(bad)],
    ['stop', (rt, bad) => rt.stop(bad)],
    ['remove', (rt, bad) => rt.remove(bad)],
    ['inspect', (rt, bad) => rt.inspect(bad)],
    ['stats', (rt, bad) => rt.stats(bad)],
    ['exec', (rt, bad) => rt.exec(bad, ['true'])],
    ['start name', (rt, bad) => rt.start(agentSpec({ name: bad }))],
    ['runForeground image', (rt, bad) => rt.runForeground(agentSpec({ image: bad }))],
  ];

  for (const [label, op] of operations) {
    it.each(hostile)(`${label}: rejects %j without calling docker`, async (bad) => {
      const { runtime, calls } = runtimeWith();
      const error = await rejection(op(runtime, bad));
      expect(error.code).toBe('INVALID_INPUT');
      expect(calls).toHaveLength(0);
    });
  }

  it('ensureNetwork and removeNetwork refuse the built-in networks', async () => {
    const { runtime, calls } = runtimeWith();
    for (const name of ['host', 'none', 'bridge']) {
      expectError(await rejection(runtime.ensureNetwork(name, { internal: false })), 'POLICY_VIOLATION', /built-in/);
      expectError(await rejection(runtime.removeNetwork(name)), 'POLICY_VIOLATION', /built-in/);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects out-of-range option values without calling docker', async () => {
    const { runtime, calls } = runtimeWith();
    expectError(await rejection(runtime.logs('c', { tail: -1 })), 'INVALID_INPUT', /tail/);
    expectError(await rejection(runtime.logs('c', { tail: 1.5 })), 'INVALID_INPUT', /tail/);
    expectError(await rejection(runtime.logs('c', { since: '--follow' })), 'INVALID_INPUT', /since/);
    expectError(await rejection(runtime.logs('c', { since: '10m; rm' })), 'INVALID_INPUT', /since/);
    expectError(await rejection(runtime.stop('c', -1)), 'INVALID_INPUT', /stop timeout/);
    expectError(await rejection(runtime.stop('c', 99999)), 'INVALID_INPUT', /stop timeout/);
    expectError(await rejection(runtime.exec('c', [])), 'INVALID_INPUT', /command/);
    expectError(await rejection(runtime.exec('c', ['a\0b'])), 'INVALID_INPUT', /command argument/);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// DockerRuntime: each method's argv and parsing
// ---------------------------------------------------------------------------

describe('DockerRuntime construction', () => {
  it('defaults to the docker binary and honours dockerBin', async () => {
    const rec = recorder(() => ({ stdout: '29.9.2\n' }));
    await new DockerRuntime({ runner: rec.runner }).ensureAvailable();
    await new DockerRuntime({ runner: rec.runner, dockerBin: '/opt/podman-docker' }).ensureAvailable();
    expect(rec.calls.map((c) => c.file)).toEqual(['docker', '/opt/podman-docker']);
  });

  it('exposes the injected runner', () => {
    const rec = recorder();
    expect(new DockerRuntime({ runner: rec.runner }).runner).toBe(rec.runner);
  });
});

describe('DockerRuntime.ensureAvailable', () => {
  it('runs docker version and returns the trimmed server version', async () => {
    const { runtime, calls } = runtimeWith(() => ({ stdout: '29.9.2\n' }));
    await expect(runtime.ensureAvailable()).resolves.toEqual({ serverVersion: '29.9.2' });
    expect(calls[0]?.args).toEqual(['version', '--format={{.Server.Version}}']);
  });

  it('classifies a missing binary, an unreachable daemon, a socket permission error and a timeout', async () => {
    const cases: Array<[Reply, ContainerErrorCode]> = [
      [{ exitCode: 127, spawnFailed: true, stderr: 'Cannot execute "docker": ENOENT' }, 'NOT_INSTALLED'],
      [failed(REAL_ERR.daemonDown), 'DAEMON_UNREACHABLE'],
      [failed(REAL_ERR.permissionDenied), 'PERMISSION_DENIED'],
      [{ exitCode: 124, timedOut: true, stderr: 'timed out' }, 'TIMEOUT'],
    ];
    for (const [reply, code] of cases) {
      const { runtime } = runtimeWith(() => reply);
      expectError(await rejection(runtime.ensureAvailable()), code);
    }
  });

  it('fails when docker succeeds but reports no version', async () => {
    const { runtime } = runtimeWith(() => ({ stdout: '\n' }));
    expectError(await rejection(runtime.ensureAvailable()), 'COMMAND_FAILED', /server version/);
  });
});

describe('DockerRuntime.inspectImage', () => {
  it('parses a real image with no labels and no user', async () => {
    const { runtime, calls } = runtimeWith(() => ({ stdout: `${REAL_IMAGE_BUSYBOX}\n` }));
    const info = await runtime.inspectImage('busybox:1.37');
    expect(calls[0]?.args).toEqual(['image', 'inspect', '--format={{json .}}', 'busybox:1.37']);
    expect(info).toEqual({
      id: 'sha256:30ecbe1509090b38ef3260f3609d64d8261230464eaa4d235901db496e9647fb',
      repoTags: ['busybox:1.37'],
      repoDigests: ['busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec'],
      labels: {},
      user: '',
      sizeBytes: 4421262,
    });
  });

  it('parses labels, user and the manifest label of a real built image', async () => {
    const { runtime } = runtimeWith(() => ({ stdout: REAL_IMAGE_LABELED }));
    const info = await runtime.inspectImage('avt-a-fixture:latest');
    expect(info?.user).toBe('10001:10001');
    expect(info?.labels['agentvault.manifest']).toBe('{"schemaVersion":1,"name":"fixture"}');
    expect(info?.labels[LABEL_MANAGED]).toBe('true');
    expect(info?.repoDigests).toEqual([]);
  });

  it('tolerates explicit nulls for Labels, User and RepoTags', async () => {
    const { runtime } = runtimeWith(() => ({ stdout: JSON.stringify({ Id: 'sha256:abc', RepoTags: null, RepoDigests: null, Size: 5, Config: { Labels: null, User: null } }) }));
    await expect(runtime.inspectImage('x')).resolves.toEqual({ id: 'sha256:abc', repoTags: [], repoDigests: [], labels: {}, user: '', sizeBytes: 5 });
  });

  it('returns null when the image does not exist', async () => {
    const { runtime } = runtimeWith(() => ({ ...failed(REAL_ERR.noSuchImage), stdout: '[]\n' }));
    await expect(runtime.inspectImage('nosuchimage-avt:latest')).resolves.toBeNull();
  });

  it('throws (does not return null) when the daemon is unreachable', async () => {
    const { runtime } = runtimeWith(() => failed(REAL_ERR.daemonDown));
    expectError(await rejection(runtime.inspectImage('busybox:1.37')), 'DAEMON_UNREACHABLE');
  });

  it('throws on output that is not an image', async () => {
    const { runtime } = runtimeWith(() => ({ stdout: '<html>not json</html>' }));
    expectError(await rejection(runtime.inspectImage('busybox:1.37')), 'COMMAND_FAILED', /Unexpected output/);
  });
});

describe('DockerRuntime.buildImage', () => {
  it('builds with BuildKit and the exact argv, then returns the image id', async () => {
    const { runtime, calls } = runtimeWith((_call, index) => (index === 1 ? { stdout: 'sha256:f5478df9\n' } : {}));
    const built = await runtime.buildImage({
      contextDir: '/tmp/ctx',
      tag: 'agentvault/demo:1',
      platform: 'linux/amd64',
      buildArgs: { NODE_ENV: 'production' },
      labels: { 'agentvault.source-hash': 'abc' },
      noCache: true,
    });
    expect(built).toEqual({ imageId: 'sha256:f5478df9', tag: 'agentvault/demo:1' });
    expect(calls[0]?.args).toEqual([
      'build',
      '--tag=agentvault/demo:1',
      '--platform=linux/amd64',
      '--build-arg=NODE_ENV=production',
      '--label=agentvault.source-hash=abc',
      '--no-cache',
      '--file=/tmp/ctx/Dockerfile',
      '/tmp/ctx',
    ]);
    expect(calls[0]?.options?.env).toEqual({ DOCKER_BUILDKIT: '1' });
    expect(calls[0]?.options?.timeoutMs).toBe(15 * 60_000);
    expect(calls[1]?.args).toEqual(['image', 'inspect', '--format={{.Id}}', 'agentvault/demo:1']);
  });

  it('uses an explicit dockerfile and timeout, and omits optional flags by default', async () => {
    const { runtime, calls } = runtimeWith((_call, index) => (index === 1 ? { stdout: 'sha256:1' } : {}));
    await runtime.buildImage({ contextDir: '/tmp/ctx', dockerfile: '/tmp/other/Dockerfile.agent', tag: 'demo:1', timeoutMs: 1234 });
    expect(calls[0]?.args).toEqual(['build', '--tag=demo:1', '--file=/tmp/other/Dockerfile.agent', '/tmp/ctx']);
    expect(calls[0]?.options?.timeoutMs).toBe(1234);
  });

  it('resolves a relative context to an absolute path (so it can never parse as a flag)', async () => {
    const { runtime, calls } = runtimeWith((_call, index) => (index === 1 ? { stdout: 'sha256:1' } : {}));
    await runtime.buildImage({ contextDir: 'relative-ctx', tag: 'demo:1' });
    const contextArg = calls[0]?.args[calls[0].args.length - 1] ?? '';
    expect(path.isAbsolute(contextArg)).toBe(true);
  });

  it('retries with the legacy builder when BuildKit is forced but buildx is missing', async () => {
    const { runtime, calls } = runtimeWith((_call, index) => {
      if (index === 0) return failed('ERROR: BuildKit is enabled but the buildx component is missing or broken.');
      if (index === 2) return { stdout: 'sha256:2' };
      return {};
    });
    const built = await runtime.buildImage({ contextDir: '/tmp/ctx', tag: 'demo:1' });
    expect(built.imageId).toBe('sha256:2');
    expect(calls[0]?.options?.env).toEqual({ DOCKER_BUILDKIT: '1' });
    expect(calls[1]?.options?.env).toEqual({ DOCKER_BUILDKIT: '0' });
  });

  it('classifies a build failure and keeps the end of the build log', async () => {
    const { runtime, calls } = runtimeWith(() => failed(`${'#5 RUN npm ci\n'.repeat(500)}ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1`));
    const error = await rejection(runtime.buildImage({ contextDir: '/tmp/ctx', tag: 'demo:1' }));
    expectError(error, 'COMMAND_FAILED', /did not complete successfully/);
    expect(calls).toHaveLength(1);
  });

  it('reports NOT_INSTALLED and TIMEOUT from the build itself', async () => {
    expectError(
      await rejection(runtimeWith(() => ({ exitCode: 127, spawnFailed: true, stderr: 'x' })).runtime.buildImage({ contextDir: '/c', tag: 't' })),
      'NOT_INSTALLED'
    );
    expectError(
      await rejection(runtimeWith(() => ({ exitCode: 124, timedOut: true, stderr: 'x' })).runtime.buildImage({ contextDir: '/c', tag: 't' })),
      'TIMEOUT'
    );
  });

  it.each([
    ['platform with a flag', { platform: '--network=host' }, /platform/],
    ['platform with a space', { platform: 'linux/amd64 --x' }, /platform/],
    ['build-arg name invalid', { buildArgs: { 'A B': '1' } }, /environment variable name/],
    ['build-arg value with LF', { buildArgs: { A: 'x\ny' } }, /build arg/],
    ['label key invalid', { labels: { 'Bad Key': '1' } }, /label key/],
    ['label value with NUL', { labels: { k: 'a\0' } }, /label/],
  ] as Array<[string, Partial<Parameters<DockerRuntime['buildImage']>[0]>, RegExp]>)('rejects %s', async (_label, extra, message) => {
    const { runtime, calls } = runtimeWith();
    expectError(await rejection(runtime.buildImage({ contextDir: '/tmp/ctx', tag: 'demo:1', ...extra })), 'INVALID_INPUT', message);
    expect(calls).toHaveLength(0);
  });

  it('rejects a NUL byte in the context or Dockerfile path', async () => {
    const { runtime, calls } = runtimeWith();
    expectError(await rejection(runtime.buildImage({ contextDir: '/tmp/a\0b', tag: 't' })), 'INVALID_INPUT', /NUL/);
    expectError(await rejection(runtime.buildImage({ contextDir: '/tmp/ctx', dockerfile: '/tmp/a\0b', tag: 't' })), 'INVALID_INPUT', /NUL/);
    expect(calls).toHaveLength(0);
  });
});

describe('DockerRuntime networks', () => {
  it('creates an internal network (with the managed label) when it does not exist', async () => {
    const rec = sequence(failed(REAL_ERR.networkNotFound), {});
    const runtime = new DockerRuntime({ runner: rec.runner });
    const calls = rec.calls;
    await runtime.ensureNetwork('av-demo-net', { internal: true, labels: { [LABEL_AGENT]: 'demo' } });
    expect(calls[0]?.args).toEqual(['network', 'inspect', '--format={{.Internal}}', 'av-demo-net']);
    expect(calls[1]?.args).toEqual([
      'network',
      'create',
      '--driver=bridge',
      '--internal',
      '--label=agentvault.agent=demo',
      '--label=agentvault.managed=true',
      'av-demo-net',
    ]);
  });

  it('creates a non-internal network without --internal', async () => {
    const rec = sequence(failed(REAL_ERR.networkNotFound), {});
    const runtime = new DockerRuntime({ runner: rec.runner });
    await runtime.ensureNetwork('av-demo-egress', { internal: false });
    expect(rec.calls[1]?.args).not.toContain('--internal');
    expect(rec.calls[1]?.args).toContain('--label=agentvault.managed=true');
  });

  it('is idempotent: an existing network with the same flag is left alone', async () => {
    for (const internal of [true, false]) {
      const rec = recorder(() => ({ stdout: `${internal}\n` }));
      await new DockerRuntime({ runner: rec.runner }).ensureNetwork('av-demo-net', { internal });
      expect(rec.calls).toHaveLength(1);
    }
  });

  it('refuses an existing NON-internal network when internal was requested (would void the lockdown)', async () => {
    const rec = recorder(() => ({ stdout: 'false\n' }));
    const error = await rejection(new DockerRuntime({ runner: rec.runner }).ensureNetwork('av-demo-net', { internal: true }));
    expectError(error, 'POLICY_VIOLATION', /already exists with internal=false/);
    expect(rec.calls).toHaveLength(1);
  });

  it('also refuses an existing internal network when a non-internal one was requested', async () => {
    const rec = recorder(() => ({ stdout: 'true\n' }));
    expectError(await rejection(new DockerRuntime({ runner: rec.runner }).ensureNetwork('av-demo-net', { internal: false })), 'POLICY_VIOLATION');
  });

  it('re-checks the flag when it loses a creation race', async () => {
    const rec = sequence(failed(REAL_ERR.networkNotFound), failed(REAL_ERR.networkExists), { stdout: 'false\n' });
    const error = await rejection(new DockerRuntime({ runner: rec.runner }).ensureNetwork('av-demo-net', { internal: true }));
    expectError(error, 'POLICY_VIOLATION');
    expect(rec.calls).toHaveLength(3);
    const ok = sequence(failed(REAL_ERR.networkNotFound), failed(REAL_ERR.networkExists), { stdout: 'true\n' });
    await new DockerRuntime({ runner: ok.runner }).ensureNetwork('av-demo-net', { internal: true });
  });

  it('propagates inspect failures that are not "not found"', async () => {
    const rec = recorder(() => failed(REAL_ERR.daemonDown));
    expectError(await rejection(new DockerRuntime({ runner: rec.runner }).ensureNetwork('n1', { internal: true })), 'DAEMON_UNREACHABLE');
    expect(rec.calls).toHaveLength(1);
  });

  it('propagates a create failure', async () => {
    const rec = sequence(failed(REAL_ERR.networkNotFound), failed('Error response from daemon: all predefined address pools have been fully subnetted'));
    expectError(await rejection(new DockerRuntime({ runner: rec.runner }).ensureNetwork('n1', { internal: true })), 'COMMAND_FAILED', /address pools/);
  });

  it('rejects unexpected inspect output instead of guessing', async () => {
    const rec = recorder(() => ({ stdout: 'maybe\n' }));
    expectError(await rejection(new DockerRuntime({ runner: rec.runner }).ensureNetwork('n1', { internal: true })), 'COMMAND_FAILED', /Unexpected output/);
  });

  it('removeNetwork runs network rm and throws NOT_FOUND when it is absent', async () => {
    const ok = recorder();
    await new DockerRuntime({ runner: ok.runner }).removeNetwork('av-demo-net');
    expect(ok.calls[0]?.args).toEqual(['network', 'rm', 'av-demo-net']);
    const missing = recorder(() => failed(REAL_ERR.networkNotFound));
    expectError(await rejection(new DockerRuntime({ runner: missing.runner }).removeNetwork('av-demo-net')), 'NOT_FOUND');
  });

  it('connectNetwork passes each alias as --alias and puts network before container', async () => {
    const { runtime, calls } = runtimeWith();
    await runtime.connectNetwork('av-demo-proxy', 'av-demo-egress', ['agentvault-proxy', 'proxy-2']);
    expect(calls[0]?.args).toEqual(['network', 'connect', '--alias=agentvault-proxy', '--alias=proxy-2', 'av-demo-egress', 'av-demo-proxy']);
    await runtime.connectNetwork('av-demo-proxy', 'av-demo-egress');
    expect(calls[1]?.args).toEqual(['network', 'connect', 'av-demo-egress', 'av-demo-proxy']);
  });

  it('connectNetwork is idempotent but still reports other failures', async () => {
    const already = recorder(() => failed(REAL_ERR.alreadyConnected));
    await new DockerRuntime({ runner: already.runner }).connectNetwork('c', 'n');
    const missing = recorder(() => failed(REAL_ERR.noSuchContainer));
    expectError(await rejection(new DockerRuntime({ runner: missing.runner }).connectNetwork('c', 'n')), 'NOT_FOUND');
  });
});

describe('DockerRuntime volumes', () => {
  it('ensureVolume creates with the managed label plus the given labels', async () => {
    const { runtime, calls } = runtimeWith();
    await runtime.ensureVolume('av-demo-data', { [LABEL_AGENT]: 'demo', 'agentvault.volume-key': 'data' });
    expect(calls[0]?.args).toEqual([
      'volume',
      'create',
      '--label=agentvault.agent=demo',
      '--label=agentvault.managed=true',
      '--label=agentvault.volume-key=data',
      'av-demo-data',
    ]);
  });

  it('ensureVolume cannot be talked out of the managed label', async () => {
    const { runtime, calls } = runtimeWith();
    await runtime.ensureVolume('av-demo-data', { [LABEL_MANAGED]: 'false' });
    expect(calls[0]?.args).toContain('--label=agentvault.managed=true');
    expect(calls[0]?.args).not.toContain('--label=agentvault.managed=false');
  });

  it('removeVolume runs volume rm and surfaces NOT_FOUND and in-use errors', async () => {
    const ok = runtimeWith();
    await ok.runtime.removeVolume('av-demo-data');
    expect(ok.calls[0]?.args).toEqual(['volume', 'rm', 'av-demo-data']);
    expectError(await rejection(runtimeWith(() => failed(REAL_ERR.noSuchVolume)).runtime.removeVolume('v1')), 'NOT_FOUND');
    expectError(
      await rejection(runtimeWith(() => failed('Error response from daemon: remove v1: volume is in use - [abc]')).runtime.removeVolume('v1')),
      'COMMAND_FAILED',
      /in use/
    );
  });

  it('removeImage runs `image rm --` and surfaces NOT_FOUND', async () => {
    const ok = runtimeWith();
    await ok.runtime.removeImage('agentvault/demo:1.0.0');
    // `--` so that a ref can never be parsed as a flag
    expect(ok.calls[0]?.args).toEqual(['image', 'rm', '--', 'agentvault/demo:1.0.0']);
    const missing = runtimeWith(() => failed('Error response from daemon: No such image: agentvault/demo:1.0.0'));
    expectError(await rejection(missing.runtime.removeImage('agentvault/demo:1.0.0')), 'NOT_FOUND');
  });

  it('listVolumes asks the daemon for exact labels and parses a real row', async () => {
    const { runtime, calls } = runtimeWith(() => ({ stdout: `${REAL_VOLUME_ROW}\n` }));
    await expect(runtime.listVolumes()).resolves.toEqual([{ name: 'avt-a-probe-vol', key: 'data', agent: 'probe1' }]);
    expect(calls[0]?.args).toEqual([
      'volume',
      'ls',
      '--filter=label=agentvault.managed=true',
      '--format={"name":{{json .Name}},"key":{{json (.Label "agentvault.volume-key")}},"agent":{{json (.Label "agentvault.agent")}}}',
    ]);
  });

  it('listVolumes filters by agent', async () => {
    const { runtime, calls } = runtimeWith();
    await runtime.listVolumes({ agent: 'demo' });
    expect(calls[0]?.args).toContain('--filter=label=agentvault.agent=demo');
  });

  it('listVolumes drops rows whose labels are not valid agent names / volume keys', async () => {
    const rows = [
      REAL_VOLUME_ROW,
      '{"name":"v-evil","key":"../../etc","agent":"probe1"}',
      '{"name":"v-evil2","key":"data","agent":"../victim"}',
      '{"name":"v-nolabels","key":"","agent":""}',
      '{"name":"v-good","key":"cfg","agent":"probe2"}',
      '',
    ].join('\n');
    const { runtime } = runtimeWith(() => ({ stdout: rows }));
    await expect(runtime.listVolumes()).resolves.toEqual([
      { name: 'avt-a-probe-vol', key: 'data', agent: 'probe1' },
      { name: 'v-good', key: 'cfg', agent: 'probe2' },
    ]);
  });

  it('listVolumes rejects output that is not JSON lines', async () => {
    const { runtime } = runtimeWith(() => ({ stdout: 'avt-a-probe-vol|data\n' }));
    expectError(await rejection(runtime.listVolumes()), 'COMMAND_FAILED', /Unexpected output/);
  });
});

describe('DockerRuntime.start', () => {
  it('forces detach and returns the container id', async () => {
    const { runtime, calls } = runtimeWith(() => ({ stdout: `${REAL_ID}\n` }));
    const started = await runtime.start(agentSpec({ detach: false }));
    expect(started).toEqual({ id: REAL_ID });
    expect(calls[0]?.args).toContain('-d');
    expect(calls[0]?.args[0]).toBe('run');
    expect(calls[0]?.file).toBe('docker');
  });

  it('maps a name conflict to a clear error', async () => {
    const { runtime } = runtimeWith(() => failed(REAL_ERR.nameInUse, 125));
    const error = await rejection(runtime.start(agentSpec()));
    expectError(error, 'COMMAND_FAILED', /container named "av-demo" already exists/);
    expect(error.details).toMatchObject({ reason: 'name_in_use', name: 'av-demo' });
  });

  it('classifies other failures', async () => {
    expectError(await rejection(runtimeWith(() => failed(REAL_ERR.daemonDown)).runtime.start(agentSpec())), 'DAEMON_UNREACHABLE');
    expectError(await rejection(runtimeWith(() => failed(REAL_ERR.networkNotFound, 125)).runtime.start(agentSpec())), 'NOT_FOUND');
  });

  it('rejects output that is not a container id', async () => {
    const { runtime } = runtimeWith(() => ({ stdout: 'hello\n' }));
    expectError(await rejection(runtime.start(agentSpec())), 'COMMAND_FAILED', /container id/);
  });

  it('ignores image-pull noise before the id', async () => {
    const { runtime } = runtimeWith(() => ({ stdout: `Unable to find image locally\n${REAL_ID}\n` }));
    await expect(runtime.start(agentSpec())).resolves.toEqual({ id: REAL_ID });
  });
});

describe('DockerRuntime.runForeground', () => {
  it('runs attached (no -d), passes io to the runner, and adds -i for a stdinFile', async () => {
    const { runtime, calls } = runtimeWith(() => ({ exitCode: 0, stdout: '' }));
    await runtime.runForeground(helperSpec({ autoRemove: true, detach: true }), {
      stdinFile: '/tmp/in.tar',
      stdoutFile: '/tmp/out.tar',
      timeoutMs: 999,
    });
    const call = calls[0]!;
    expect(call.args).not.toContain('-d');
    expect(call.args).toContain('-i');
    expect(call.args).toContain('--rm');
    expect(call.options).toEqual({ stdinFile: '/tmp/in.tar', stdoutFile: '/tmp/out.tar', timeoutMs: 999 });
  });

  it('does not add -i without a stdinFile, and forwards inheritStdio', async () => {
    const { runtime, calls } = runtimeWith();
    await runtime.runForeground(agentSpec(), { inheritStdio: true });
    expect(calls[0]?.args).not.toContain('-i');
    expect(calls[0]?.options).toEqual({ inheritStdio: true });
  });

  it('returns a non-zero exit instead of throwing', async () => {
    const { runtime } = runtimeWith(() => ({ exitCode: 1, stderr: 'tar: ./secret: Cannot open: Permission denied' }));
    const r = await runtime.runForeground(helperSpec());
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Permission denied');
  });

  it('returns a timeout result instead of throwing', async () => {
    const { runtime } = runtimeWith(() => ({ exitCode: 124, timedOut: true, stderr: 'timed out' }));
    const r = await runtime.runForeground(agentSpec());
    expect(r.timedOut).toBe(true);
  });

  it.each([
    ['binary not installed', { exitCode: 127, spawnFailed: true, stderr: 'Cannot execute "docker": ENOENT' }, 'NOT_INSTALLED'],
    ['daemon unreachable', failed(REAL_ERR.daemonDown), 'DAEMON_UNREACHABLE'],
    ['classic daemon unreachable', failed(REAL_ERR.daemonDownClassic), 'DAEMON_UNREACHABLE'],
    ['socket permission denied', failed(REAL_ERR.permissionDenied), 'PERMISSION_DENIED'],
  ] as Array<[string, Reply, ContainerErrorCode]>)('throws for %s', async (_label, reply, code) => {
    const { runtime } = runtimeWith(() => reply);
    expectError(await rejection(runtime.runForeground(agentSpec())), code);
  });

  it('does not let a container that prints a daemon error turn its own exit into an infrastructure error', async () => {
    const { runtime } = runtimeWith(() => ({ exitCode: 1, stderr: `agent starting\nfatal: ${REAL_ERR.daemonDownClassic}` }));
    const r = await runtime.runForeground(agentSpec());
    expect(r.exitCode).toBe(1);
  });
});

describe('DockerRuntime.list', () => {
  it('lists running managed containers with the exact filter and format', async () => {
    const { runtime, calls } = runtimeWith(() => ({ stdout: `${REAL_PS_ROW}\n` }));
    const [info] = await runtime.list();
    expect(calls[0]?.args.slice(0, 3)).toEqual(['ps', '--filter=label=agentvault.managed=true', calls[0]?.args[2]]);
    expect(calls[0]?.args).not.toContain('-a');
    expect(calls[0]?.args[2]).toMatch(/^--format=\{"id":\{\{json \.ID\}\}/);
    expect(calls[0]?.args[2]).toContain('{{json (.Label "agentvault.role")}}');
    expect(info).toMatchObject({
      id: '07e0c866ed5d',
      name: 'avt-a-fx',
      image: 'avt-a-fixture:latest',
      state: 'running',
      status: 'Up Less than a second',
      role: 'agent',
      agent: 'fx',
      createdAt: '2026-11-05 05:24:30 +0000 UTC',
    });
    expect(info?.labels[LABEL_AGENT]).toBe('fx');
    expect(info?.labels['agentvault.manifest']).toBe('{"schemaVersion":1,"name":"fixture"}');
  });

  it('adds -a and the agent filter when asked', async () => {
    const { runtime, calls } = runtimeWith();
    await runtime.list({ agent: 'demo', all: true });
    expect(calls[0]?.args.slice(0, 4)).toEqual(['ps', '-a', '--filter=label=agentvault.managed=true', '--filter=label=agentvault.agent=demo']);
  });

  it('returns [] for empty output', async () => {
    const { runtime } = runtimeWith(() => ({ stdout: '\n' }));
    await expect(runtime.list({ all: true })).resolves.toEqual([]);
  });

  it('takes role and agent from the exact .Label values, not from the spoofable flat string', async () => {
    const { runtime } = runtimeWith(() => ({ stdout: REAL_PS_ROW_SPOOFED }));
    const [info] = await runtime.list();
    expect(REAL_PS_ROW_SPOOFED).toContain('agentvault.agent=victim');
    expect(info?.agent).toBe('probe1');
    expect(info?.labels[LABEL_AGENT]).toBe('probe1');
  });

  it('reports an unknown role for containers without a recognised role label', async () => {
    const row = JSON.stringify({ id: 'abc', names: 'x', image: 'i', state: 'exited', status: 'Exited (0) 1 minute ago', createdAt: 'now', labels: 'agentvault.managed=true', role: '', agent: '' });
    const { runtime } = runtimeWith(() => ({ stdout: row }));
    const [info] = await runtime.list({ all: true });
    expect(info).toMatchObject({ role: 'unknown', agent: '', state: 'exited' });
  });

  it('takes the first name and strips a leading slash', async () => {
    const row = JSON.stringify({ id: 'abc', names: '/first,second/alias', image: 'i', state: 'running', status: 'Up', createdAt: 'now', labels: null, role: 'proxy', agent: 'a1' });
    const { runtime } = runtimeWith(() => ({ stdout: row }));
    const [info] = await runtime.list();
    expect(info?.name).toBe('first');
    expect(info?.role).toBe('proxy');
  });

  it('rejects unparseable output', async () => {
    expectError(await rejection(runtimeWith(() => ({ stdout: 'CONTAINER ID   IMAGE\n' })).runtime.list()), 'COMMAND_FAILED', /Unexpected output/);
    expectError(await rejection(runtimeWith(() => ({ stdout: '{"id":"x"}' })).runtime.list()), 'COMMAND_FAILED', /Unexpected output/);
  });

  it('throws classified errors', async () => {
    expectError(await rejection(runtimeWith(() => failed(REAL_ERR.daemonDown)).runtime.list()), 'DAEMON_UNREACHABLE');
  });
});

describe('parseDockerLabels', () => {
  it('parses the flat string docker prints', () => {
    expect(parseDockerLabels('agentvault.agent=fx,agentvault.managed=true,agentvault.role=agent')).toEqual({
      'agentvault.agent': 'fx',
      'agentvault.managed': 'true',
      'agentvault.role': 'agent',
    });
  });

  it('keeps a comma inside a value when the continuation does not look like key=value', () => {
    expect(parseDockerLabels('a=1,b=x,y,c=3')).toEqual({ a: '1', b: 'x,y', c: '3' });
  });

  it('keeps equals signs inside values', () => {
    expect(parseDockerLabels('k=a=b')).toEqual({ k: 'a=b' });
  });

  it('handles empty, null and undefined', () => {
    expect(parseDockerLabels('')).toEqual({});
    expect(parseDockerLabels(null)).toEqual({});
    expect(parseDockerLabels(undefined)).toEqual({});
  });
});

describe('DockerRuntime.logs', () => {
  it('captures logs with tail and since', async () => {
    const { runtime, calls } = runtimeWith(() => ({ stdout: 'hello\n', stderr: 'warn' }));
    const r = await runtime.logs('av-demo', { tail: 50, since: '10m' });
    expect(calls[0]?.args).toEqual(['logs', '--tail=50', '--since=10m', 'av-demo']);
    expect(calls[0]?.options?.inheritStdio).toBeUndefined();
    expect(r.stdout).toBe('hello\n');
    expect(r.stderr).toBe('warn');
  });

  it('accepts an RFC 3339 since and tail 0', async () => {
    const { runtime, calls } = runtimeWith();
    await runtime.logs('av-demo', { tail: 0, since: '2026-11-05T05:00:00Z' });
    expect(calls[0]?.args).toEqual(['logs', '--tail=0', '--since=2026-11-05T05:00:00Z', 'av-demo']);
  });

  it('follow streams straight to the terminal (inheritStdio, no timeout)', async () => {
    const { runtime, calls } = runtimeWith();
    await runtime.logs('av-demo', { follow: true, tail: 10 });
    expect(calls[0]?.args).toEqual(['logs', '--tail=10', '--follow', 'av-demo']);
    expect(calls[0]?.options).toEqual({ inheritStdio: true });
  });

  it('follow returns the exit code of an interrupted stream instead of throwing', async () => {
    const { runtime } = runtimeWith(() => ({ exitCode: 130 }));
    await expect(runtime.logs('av-demo', { follow: true })).resolves.toMatchObject({ exitCode: 130 });
  });

  it('follow still reports a missing docker binary', async () => {
    const { runtime } = runtimeWith(() => ({ exitCode: 127, spawnFailed: true, stderr: 'x' }));
    expectError(await rejection(runtime.logs('av-demo', { follow: true })), 'NOT_INSTALLED');
  });

  it('throws NOT_FOUND for a missing container', async () => {
    const { runtime } = runtimeWith(() => failed(REAL_ERR.noSuchContainer));
    expectError(await rejection(runtime.logs('avt-a-probe-nope')), 'NOT_FOUND');
  });
});

describe('DockerRuntime.stop and remove', () => {
  it('stop uses -t (not the deprecated --time) with the default of 10 seconds', async () => {
    const { runtime, calls } = runtimeWith();
    await runtime.stop('av-demo');
    await runtime.stop('av-demo', 3);
    expect(calls[0]?.args).toEqual(['stop', '-t', '10', 'av-demo']);
    expect(calls[1]?.args).toEqual(['stop', '-t', '3', 'av-demo']);
    expect(calls[1]?.options?.timeoutMs).toBe(33_000);
  });

  it('stop throws NOT_FOUND for a missing container', async () => {
    const { runtime } = runtimeWith(() => failed(`Flag --time has been deprecated, use --timeout instead\n${REAL_ERR.noSuchContainer}`));
    expectError(await rejection(runtime.stop('avt-a-probe-nope')), 'NOT_FOUND');
  });

  it('remove passes -f only when forced', async () => {
    const { runtime, calls } = runtimeWith();
    await runtime.remove('av-demo');
    await runtime.remove('av-demo', { force: true });
    await runtime.remove('av-demo', { force: false });
    expect(calls.map((c) => c.args)).toEqual([['rm', 'av-demo'], ['rm', '-f', 'av-demo'], ['rm', 'av-demo']]);
  });

  it('remove throws NOT_FOUND for a missing container and COMMAND_FAILED for a running one', async () => {
    expectError(await rejection(runtimeWith(() => failed(REAL_ERR.noSuchContainer)).runtime.remove('x1')), 'NOT_FOUND');
    expectError(
      await rejection(runtimeWith(() => failed('Error response from daemon: cannot remove container "/x1": container is running: stop the container before removing or force remove')).runtime.remove('x1')),
      'COMMAND_FAILED',
      /is running/
    );
  });
});

describe('DockerRuntime.inspect', () => {
  it('uses `container inspect` so an image or volume of the same name is never returned', async () => {
    const { runtime, calls } = runtimeWith(() => ({ stdout: `[${REAL_CONTAINER_INSPECT}]` }));
    await runtime.inspect('avt-a-fx');
    expect(calls[0]?.args).toEqual(['container', 'inspect', 'avt-a-fx']);
  });

  it('returns the parsed object from a real inspect', async () => {
    const { runtime } = runtimeWith(() => ({ stdout: `[${REAL_CONTAINER_INSPECT}]` }));
    const info = (await runtime.inspect('avt-a-fx')) as { Name: string; State: { Status: string }; HostConfig: { CapDrop: string[]; ReadonlyRootfs: boolean } };
    expect(info.Name).toBe('/avt-a-fx');
    expect(info.State.Status).toBe('running');
    expect(info.HostConfig.CapDrop).toEqual(['ALL']);
    expect(info.HostConfig.ReadonlyRootfs).toBe(true);
  });

  it('redacts environment values but keeps the names', async () => {
    const { runtime } = runtimeWith(() => ({ stdout: `[${REAL_CONTAINER_INSPECT}]` }));
    const info = (await runtime.inspect('avt-a-fx')) as { Config: { Env: string[] } };
    expect(REAL_CONTAINER_INSPECT).toContain('sk-FIXTURE-SECRET-123');
    expect(JSON.stringify(info)).not.toContain('sk-FIXTURE-SECRET-123');
    expect(info.Config.Env).toEqual(['API_KEY=<redacted>', 'PATH=<redacted>']);
  });

  it('throws NOT_FOUND for a missing container and for an empty array', async () => {
    expectError(await rejection(runtimeWith(() => ({ ...failed(REAL_ERR.noSuchContainer), stdout: '[]\n' })).runtime.inspect('x1')), 'NOT_FOUND');
    expectError(await rejection(runtimeWith(() => ({ stdout: '[]' })).runtime.inspect('x1')), 'NOT_FOUND');
  });

  it('throws on non-JSON output', async () => {
    expectError(await rejection(runtimeWith(() => ({ stdout: 'oops' })).runtime.inspect('x1')), 'COMMAND_FAILED', /Unexpected output/);
  });
});

describe('DockerRuntime.stats and exec', () => {
  it('stats runs --no-stream and returns the table', async () => {
    const { runtime, calls } = runtimeWith(() => ({ stdout: REAL_STATS }));
    const r = await runtime.stats('avt-a-fx');
    expect(calls[0]?.args).toEqual(['stats', '--no-stream', 'avt-a-fx']);
    expect(r.stdout).toContain('avt-a-fx');
  });

  it('stats throws NOT_FOUND for a missing container', async () => {
    expectError(await rejection(runtimeWith(() => failed(REAL_ERR.noSuchContainer)).runtime.stats('x1')), 'NOT_FOUND');
  });

  it('exec passes the command as argv after the container name', async () => {
    const { runtime, calls } = runtimeWith(() => ({ stdout: 'hi\n' }));
    const r = await runtime.exec('av-demo', ['sh', '-c', 'echo hi; id'], {});
    expect(calls[0]?.args).toEqual(['exec', 'av-demo', 'sh', '-c', 'echo hi; id']);
    expect(calls[0]?.options).toEqual({});
    expect(r.stdout).toBe('hi\n');
  });

  it('exec keeps flag-looking command words after the container name', async () => {
    const { runtime, calls } = runtimeWith();
    await runtime.exec('av-demo', ['--help', '-i']);
    expect(calls[0]?.args).toEqual(['exec', 'av-demo', '--help', '-i']);
  });

  it('interactive exec inherits stdio and adds -t only on a terminal', async () => {
    const rec = recorder();
    await new DockerRuntime({ runner: rec.runner, isTty: () => false }).exec('av-demo', ['sh'], { interactive: true });
    await new DockerRuntime({ runner: rec.runner, isTty: () => true }).exec('av-demo', ['sh'], { interactive: true });
    expect(rec.calls[0]?.args).toEqual(['exec', '-i', 'av-demo', 'sh']);
    expect(rec.calls[1]?.args).toEqual(['exec', '-i', '-t', 'av-demo', 'sh']);
    expect(rec.calls[0]?.options).toEqual({ inheritStdio: true });
  });

  it('exec returns the command exit code without throwing', async () => {
    const { runtime } = runtimeWith(() => ({ exitCode: 7 }));
    await expect(runtime.exec('av-demo', ['sh', '-c', 'exit 7'])).resolves.toMatchObject({ exitCode: 7 });
  });

  it('exec throws for a missing container, a stopped docker and a missing binary', async () => {
    expectError(await rejection(runtimeWith(() => failed(REAL_ERR.noSuchContainer)).runtime.exec('x1', ['true'])), 'NOT_FOUND');
    expectError(await rejection(runtimeWith(() => failed(REAL_ERR.daemonDown)).runtime.exec('x1', ['true'])), 'DAEMON_UNREACHABLE');
    expectError(await rejection(runtimeWith(() => ({ exitCode: 127, spawnFailed: true, stderr: 'x' })).runtime.exec('x1', ['true'])), 'NOT_INSTALLED');
  });

  it('exec does not mistake the command\'s own "No such container" output for a docker error', async () => {
    const { runtime } = runtimeWith(() => ({ exitCode: 1, stderr: 'my-tool: No such container: foo' }));
    await expect(runtime.exec('x1', ['my-tool'])).resolves.toMatchObject({ exitCode: 1 });
  });
});
