/**
 * 特权守护进程（Privileged Supervisor）
 *
 * 背景：
 * 旧的实现中，TUN 模式的每次启动/停止/重启都会通过 osascript / UAC / pkexec
 * 单独请求一次管理员授权，导致一个会话内出现多次弹窗。
 *
 * 本模块的做法：
 * - 首次进入 TUN 模式时，只请求一次管理员授权，拉起一个常驻的提权守护进程；
 * - 该守护进程（root / admin）负责 sing-box 的完整生命周期：
 *   start / stop / restart / 残留进程清理 / quit；
 * - 之后本会话内所有 TUN 操作都通过“命令文件 + 序列号”下发到守护进程，不再弹窗；
 * - 守护进程在 App 退出后仍可被下一次会话复用（只要指纹匹配合法），
 *   并带空闲超时（长时间无事可做自动退出），避免 root 进程永久驻留。
 *
 * 协议（所有平台统一，文件都位于 userData 目录下）：
 * - flowz_cmd          命令内容：start | stop | restart | quit
 * - flowz_seq          单调递增的序列号（字符串），守护进程仅在序列号变化时处理命令
 * - flowz_supervisor.pid  守护进程自身 PID
 * - flowz_supervisor.log  守护进程日志
 * - flowz_supervisor.singpath  记录启动时的 sing-box 路径，用于重启后指纹校验
 */

import { spawn, execFile, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type SupervisorLogFn = (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;

export type SupervisorCommand = 'start' | 'stop' | 'restart' | 'quit';

/** 守护进程空闲超时（秒）：无 sing-box 运行且长时间无命令时自动退出 */
const IDLE_TIMEOUT_SECONDS = 1800;

/** 等待守护进程就绪的超时（毫秒） */
const STARTUP_TIMEOUT_MS = 60000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 生成 macOS / Linux 使用的 bash 守护进程脚本
 */
function buildUnixScript(
  singboxPath: string,
  configPath: string,
  userDataPath: string,
  pidFilePath: string
): string {
  const q = shellQuote;
  return [
    '#!/bin/bash',
    '# FlowZ Privileged Supervisor (Unix) - 由单次管理员授权启动，持续接管 sing-box 生命周期',
    `SINGBOX_PATH=${q(singboxPath)}`,
    `USERDATA=${q(userDataPath)}`,
    `CONFIG_PATH=${q(configPath)}`,
    '',
    `PID_FILE=${q(pidFilePath)}`,
    `SUP_PID_FILE="$USERDATA/flowz_supervisor.pid"`,
    `CMD_FILE="$USERDATA/flowz_cmd"`,
    `SEQ_FILE="$USERDATA/flowz_seq"`,
    `LOG_FILE="$USERDATA/flowz_supervisor.log"`,
    `IDLE_TIMEOUT=${IDLE_TIMEOUT_SECONDS}`,
    '',
    'log() {',
    '  echo "[$(date \'+%Y-%m-%d %H:%M:%S\')] $1" >> "$LOG_FILE" 2>/dev/null || true',
    '}',
    '',
    'if [ "$(id -u)" != "0" ]; then',
    '  log "supervisor must run as root"',
    '  exit 1',
    'fi',
    '',
    'echo $$ > "$SUP_PID_FILE" 2>/dev/null || true',
    'log "supervisor started PID=$$"',
    '',
    'SBPID=""',
    'last_seq=""',
    'last_cmd_time=$(date +%s)',
    '',
    'stop_singbox() {',
    '  local pid=""',
    '  local is_child=""',
    '  if [ -n "$SBPID" ]; then',
    '    pid="$SBPID"',
    '    is_child="1"',
    '  elif [ -f "$PID_FILE" ]; then',
    '    pid=$(cat "$PID_FILE" 2>/dev/null || echo "")',
    '  fi',
    '  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then',
    '    log "stopping sing-box PID=$pid (SIGTERM)"',
    '    kill -TERM "$pid" 2>/dev/null',
    '    local i=0',
    '    while [ $i -lt 30 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.2; i=$((i+1)); done',
    '    if kill -0 "$pid" 2>/dev/null; then',
    '      log "sing-box still alive, SIGKILL PID=$pid"',
    '      kill -9 "$pid" 2>/dev/null',
    '      sleep 0.5',
    '    fi',
    '    if [ -n "$is_child" ]; then',
    '      wait "$pid" 2>/dev/null',
    '    fi',
    '  fi',
    '  rm -f "$PID_FILE" 2>/dev/null',
    '  SBPID=""',
    '  log "sing-box stopped"',
    '}',
    '',
    'cleanup_stale() {',
    '  local pids=""',
    '  pids=$(/usr/bin/pgrep -f \'sing-box\' 2>/dev/null || echo "")',
    '  local p',
    '  for p in $pids; do',
    '    if [ -n "$p" ] && [ "$p" != "$$" ] && kill -0 "$p" 2>/dev/null; then',
    '      log "killing stale sing-box PID=$p"',
    '      kill -9 "$p" 2>/dev/null || true',
    '    fi',
    '  done',
    '  sleep 0.3',
    '}',
    '',
    'start_singbox() {',
    '  # 同一提权上下文内先清理旧进程/残留，再启动新的',
    '  stop_singbox',
    '  cleanup_stale',
    '  log "starting sing-box"',
    '  "$SINGBOX_PATH" run -c "$CONFIG_PATH" >/dev/null 2>&1 &',
    '  SBPID=$!',
    '  echo "$SBPID" > "$PID_FILE" 2>/dev/null || true',
    '  chmod 644 "$PID_FILE" 2>/dev/null || true',
    '  log "sing-box started PID=$SBPID"',
    '}',
    '',
    'while true; do',
    '  # 侦听 sing-box 意外退出',
    '  if [ -n "$SBPID" ] && ! kill -0 "$SBPID" 2>/dev/null; then',
    '    log "sing-box PID=$SBPID exited unexpectedly"',
    '    wait "$SBPID" 2>/dev/null',
    '    SBPID=""',
    '    rm -f "$PID_FILE" 2>/dev/null',
    '  fi',
    '',
    '  # 读取命令',
    '  cur_seq=""',
    '  if [ -f "$SEQ_FILE" ]; then',
    '    cur_seq=$(cat "$SEQ_FILE" 2>/dev/null || echo "")',
    '  fi',
    '',
    '  if [ -n "$cur_seq" ] && [ "$cur_seq" != "$last_seq" ]; then',
    '    last_seq="$cur_seq"',
    '    cmd=""',
    '    if [ -f "$CMD_FILE" ]; then',
    '      cmd=$(cat "$CMD_FILE" 2>/dev/null || echo "")',
    '    fi',
    '    case "$cmd" in',
    '      start)',
    '        start_singbox',
    '        ;;',
    '      stop)',
    '        stop_singbox',
    '        ;;',
    '      restart)',
    '        stop_singbox',
    '        start_singbox',
    '        ;;',
    '      quit)',
    '        log "quit command received"',
    '        stop_singbox',
    '        rm -f "$SUP_PID_FILE" "$PID_FILE" 2>/dev/null',
    '        log "supervisor exiting"',
    '        exit 0',
    '        ;;',
    '      *)',
    '        log "unknown command: $cmd"',
    '        ;;',
    '    esac',
    '    last_cmd_time=$(date +%s)',
    '  fi',
    '',
    '  # 空闲超时自清理',
    '  now=$(date +%s)',
    '  if [ -z "$SBPID" ] && [ $((now - last_cmd_time)) -ge "$IDLE_TIMEOUT" ]; then',
    '    log "idle timeout, exiting"',
    '    rm -f "$SUP_PID_FILE" "$PID_FILE" 2>/dev/null',
    '    exit 0',
    '  fi',
    '',
    '  sleep 0.25',
    'done',
  ].join('\n');
}

/**
 * 生成 Windows 使用的 PowerShell 守护进程脚本
 */
function buildWindowsScript(
  singboxPath: string,
  configPath: string,
  userDataPath: string,
  pidFilePath: string
): string {
  const p = (s: string) => s.replace(/'/g, "''");
  return [
    '# FlowZ Privileged Supervisor (Windows) - 由单次 UAC 授权启动',
    "$ErrorActionPreference = 'SilentlyContinue'",
    '',
    `$singbox = '${p(singboxPath)}'`,
    `$userData = '${p(userDataPath)}'`,
    `$config = '${p(configPath)}'`,
    `$pidFile = '${p(pidFilePath)}'`,
    '$supPidFile = "$userData\\flowz_supervisor.pid"',
    '$cmdFile = "$userData\\flowz_cmd"',
    '$seqFile = "$userData\\flowz_seq"',
    '$logFile = "$userData\\flowz_supervisor.log"',
    `$idleTimeout = ${IDLE_TIMEOUT_SECONDS}`,
    '',
    'function Log([string]$msg) {',
    '  Add-Content -Path $logFile -Value ("[{0}] {1}" -f (Get-Date -Format \'yyyy-MM-dd HH:mm:ss\'), $msg) -Encoding UTF8',
    '}',
    '',
    '$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    'if (-not $isAdmin) {',
    "  Log 'supervisor must run as administrator'",
    '  exit 1',
    '}',
    '',
    'Set-Content -Path $supPidFile -Value $PID -Encoding ASCII -Force',
    'Log ("supervisor started PID={0}" -f $PID)',
    '',
    '$script:sbPid = 0',
    "$script:lastSeq = ''",
    '$script:idleStart = Get-Date',
    '',
    'function Stop-Singbox {',
    '  $target = $script:sbPid',
    '  if ($target -le 0 -and (Test-Path $pidFile)) {',
    '    $content = Get-Content $pidFile -Raw -ErrorAction SilentlyContinue',
    '    if ($content) {',
    '      try { [int]$target = $content.Trim() } catch { $target = 0 }',
    '    }',
    '  }',
    '  if ($target -gt 0) {',
    '    $proc = Get-Process -Id $target -ErrorAction SilentlyContinue',
    '    if ($proc) {',
    '      Log ("stopping sing-box PID={0}" -f $target)',
    '      Stop-Process -Id $target -Force -ErrorAction SilentlyContinue',
    '      Start-Sleep -Milliseconds 500',
    '    }',
    '  }',
    '  Remove-Item $pidFile -ErrorAction SilentlyContinue',
    '  $script:sbPid = 0',
    "  Log 'sing-box stopped'",
    '}',
    '',
    'function Start-Singbox {',
    '  Stop-Singbox',
    "  Get-Process -Name 'sing-box' -ErrorAction SilentlyContinue | ForEach-Object {",
    '    Log ("killing stale sing-box PID={0}" -f $_.Id)',
    '    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue',
    '  }',
    '  Start-Sleep -Milliseconds 300',
    "  Log 'starting sing-box'",
    '  $psi = New-Object System.Diagnostics.ProcessStartInfo',
    '  $psi.FileName = $singbox',
    '  $psi.Arguments = "run -c `"$config`""',
    '  $psi.UseShellExecute = $false',
    '  $psi.CreateNoWindow = $true',
    '  $p = [System.Diagnostics.Process]::Start($psi)',
    '  $script:sbPid = $p.Id',
    '  Set-Content -Path $pidFile -Value $script:sbPid -Encoding ASCII -Force',
    '  Log ("sing-box started PID={0}" -f $script:sbPid)',
    '  $script:idleStart = Get-Date',
    '}',
    '',
    'while ($true) {',
    '  if ($script:sbPid -gt 0) {',
    '    $alive = Get-Process -Id $script:sbPid -ErrorAction SilentlyContinue',
    '    if (-not $alive) {',
    '      Log ("sing-box PID={0} exited unexpectedly" -f $script:sbPid)',
    '      Remove-Item $pidFile -ErrorAction SilentlyContinue',
    '      $script:sbPid = 0',
    '    }',
    '  }',
    '',
    "  $curSeq = ''",
    '  if (Test-Path $seqFile) {',
    '    $curSeq = (Get-Content $seqFile -Raw -ErrorAction SilentlyContinue).Trim()',
    '  }',
    '',
    "  if ($curSeq -ne '' -and $curSeq -ne $script:lastSeq) {",
    '    $script:lastSeq = $curSeq',
    "    $cmd = ''",
    '    if (Test-Path $cmdFile) {',
    '      $cmd = (Get-Content $cmdFile -Raw -ErrorAction SilentlyContinue).Trim()',
    '    }',
    '    switch ($cmd) {',
    "      'start'   { Start-Singbox }",
    "      'stop'    { Stop-Singbox }",
    "      'restart' { Stop-Singbox; Start-Singbox }",
    "      'quit'    { Log 'quit command received'; Stop-Singbox; Remove-Item $supPidFile,$pidFile -ErrorAction SilentlyContinue; Log 'supervisor exiting'; exit 0 }",
    '      default   { Log ("unknown command: {0}" -f $cmd) }',
    '    }',
    '    $script:idleStart = Get-Date',
    '  }',
    '',
    '  if ($script:sbPid -le 0) {',
    '    $idleSecs = ((Get-Date) - $script:idleStart).TotalSeconds',
    '    if ($idleSecs -ge $idleTimeout) {',
    "      Log 'idle timeout, exiting'",
    '      Remove-Item $supPidFile -ErrorAction SilentlyContinue',
    '      exit 0',
    '    }',
    '  }',
    '  Start-Sleep -Milliseconds 250',
    '}',
  ].join('\n');
}

export class PrivilegedSupervisor {
  private singboxPath: string;
  private configPath: string;
  private userDataPath: string;
  private pidFilePath: string;
  private log?: SupervisorLogFn;

  /** 拉起守护进程的启动器（osascript / pkexec / powershell），用于跟踪生命周期 */
  private launcher: ChildProcess | null = null;

  /** 命令序列号计数（保证同一毫秒内多次命令也单调递增） */
  private commandSeq = 0;

  constructor(
    singboxPath: string,
    configPath: string,
    userDataPath: string,
    pidFilePath: string,
    log?: SupervisorLogFn
  ) {
    this.singboxPath = singboxPath;
    this.configPath = configPath;
    this.userDataPath = userDataPath;
    this.pidFilePath = pidFilePath;
    this.log = log;
  }

  /* ------------------------------------------------------------------ */
  /* 公开接口                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * 确保特权守护进程正在运行。
   * - 已有存活且指纹匹配的守护进程 → 直接复用（无需授权弹窗）；
   * - 否则 → 单次授权拉起新守护进程；
   * - 返回 false 表示用户取消授权或拉起失败。
   */
  async ensureStarted(): Promise<boolean> {
    if ((await this.isSupervisorAlive()) && this.fingerprintMatches()) {
      this.log?.('debug', '复用已运行的特权守护进程，无需再次授权');
      return true;
    }

    // 存活但指纹不匹配（如升级后 sing-box 路径变化）：让旧进程退出
    if (await this.isSupervisorAlive()) {
      this.log?.('info', '检测到旧版特权守护进程，正在退出以便重建');
      await this.shutdown();
    }

    this.removeStaleFiles();

    if (!this.writeFingerprint()) {
      return false;
    }

    if (!this.writeSupervisorScripts()) {
      return false;
    }

    if (!this.launchSupervisor()) {
      return false;
    }

    const started = await this.waitForSupervisorReady(STARTUP_TIMEOUT_MS);
    if (!started) {
      this.log?.('warn', '特权守护进程未能就绪（用户可能取消了授权）');
    }
    return started;
  }

  /** 下发一个命令到守护进程 */
  sendCommand(cmd: SupervisorCommand): void {
    const seq = this.nextSeq();
    try {
      fs.writeFileSync(this.cmdFile(), cmd, 'utf-8');
    } catch (e: any) {
      this.log?.('warn', `写入命令 ${cmd} 失败: ${e.message}`);
      return;
    }
    try {
      fs.writeFileSync(this.seqFile(), seq, 'utf-8');
    } catch (e: any) {
      this.log?.('warn', `写入命令序列号失败: ${e.message}`);
    }
  }

  /** 停止守护进程（内部会先停止 sing-box），用于 App 退出前清理 */
  async shutdown(): Promise<void> {
    const launcher = this.launcher;

    if (!(await this.isSupervisorAlive())) {
      if (launcher && launcher.exitCode === null) {
        try {
          launcher.kill();
        } catch {
          // 忽略
        }
      }
      this.launcher = null;
      return;
    }

    try {
      const seq = this.nextSeq();
      fs.writeFileSync(this.cmdFile(), 'quit', 'utf-8');
      fs.writeFileSync(this.seqFile(), seq, 'utf-8');
    } catch {
      // 忽略
    }

    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (!(await this.isSupervisorAlive())) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (launcher && launcher.exitCode === null) {
      try {
        launcher.kill();
      } catch {
        // 忽略
      }
    }
    this.launcher = null;
  }

  /* ------------------------------------------------------------------ */
  /* 内部逻辑                                                             */
  /* ------------------------------------------------------------------ */

  /** 命令文件路径 */
  private cmdFile(): string {
    return path.join(this.userDataPath, 'flowz_cmd');
  }

  /** 序列号文件路径 */
  private seqFile(): string {
    return path.join(this.userDataPath, 'flowz_seq');
  }

  /** 守护进程 PID 文件路径 */
  private supPidFile(): string {
    return path.join(this.userDataPath, 'flowz_supervisor.pid');
  }

  /** sing-box 路径指纹文件路径 */
  private singPathRecordFile(): string {
    return path.join(this.userDataPath, 'flowz_supervisor.singpath');
  }

  /** bash / PowerShell 脚本路径 */
  private scriptFile(): string {
    return process.platform === 'win32'
      ? path.join(this.userDataPath, 'flowz_supervisor.ps1')
      : path.join(this.userDataPath, 'flowz_supervisor.sh');
  }

  private nextSeq(): string {
    this.commandSeq++;
    return `${Date.now().toString(36)}-${process.pid}-${this.commandSeq}`;
  }

  private readPid(file: string): number | null {
    try {
      const content = fs.readFileSync(file, 'utf-8').trim();
      const pid = parseInt(content, 10);
      return !isNaN(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private async isProcessAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      if (e.code === 'ESRCH') {
        return false;
      }
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      const done = (alive: boolean) => {
        clearTimeout(timeout);
        resolve(alive);
      };

      if (process.platform === 'win32') {
        execFile(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'dead' }`,
          ],
          { windowsHide: true },
          (_err, stdout) => done(stdout.trim().toLowerCase() === 'alive')
        );
      } else {
        execFile('ps', ['-p', String(pid), '-o', 'pid='], (_err, stdout) =>
          done(stdout.trim() === String(pid))
        );
      }
    });
  }

  private async isSupervisorAlive(): Promise<boolean> {
    const pid = this.readPid(this.supPidFile());
    if (!pid) {
      return false;
    }
    return this.isProcessAlive(pid);
  }

  /** 判断记录中的 sing-box 路径与当前是否一致（决定能否复用旧守护进程） */
  private fingerprintMatches(): boolean {
    try {
      const recorded = fs.readFileSync(this.singPathRecordFile(), 'utf-8').trim();
      return recorded !== '' && recorded === this.singboxPath;
    } catch {
      return false;
    }
  }

  private writeFingerprint(): boolean {
    try {
      fs.writeFileSync(this.singPathRecordFile(), this.singboxPath, 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /** 清理可能残留的过期协议文件（不动 singbox.pid，供新守护进程停止旧进程时读取） */
  private removeStaleFiles(): void {
    for (const file of [this.supPidFile(), this.cmdFile(), this.seqFile()]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // 不存在则忽略
      }
    }
  }

  private writeSupervisorScripts(): boolean {
    try {
      const content =
        process.platform === 'win32'
          ? buildWindowsScript(
              this.singboxPath,
              this.configPath,
              this.userDataPath,
              this.pidFilePath
            )
          : buildUnixScript(this.singboxPath, this.configPath, this.userDataPath, this.pidFilePath);
      fs.writeFileSync(this.scriptFile(), content, {
        encoding: 'utf-8',
        mode: 0o755,
      });
      return true;
    } catch (e: any) {
      this.log?.('error', `写入特权守护进程脚本失败: ${e.message}`);
      return false;
    }
  }

  /**
   * 以管理员权限拉起守护进程，仅触发一次授权。
   * 该进程会持续运行，直到收到 quit 命令或空闲超时。
   */
  private launchSupervisor(): boolean {
    try {
      if (process.platform === 'darwin') {
        this.launcher = spawn('/usr/bin/osascript', [
          '-e',
          `do shell script "/bin/bash ${shellQuote(this.scriptFile())}" with administrator privileges`,
        ]);
      } else if (process.platform === 'linux') {
        this.launcher = spawn('/usr/bin/pkexec', ['/bin/bash', this.scriptFile()]);
      } else if (process.platform === 'win32') {
        // 通过 -EncodedCommand 传参，避免 Start-Process 对含空格路径的去引号问题
        const encoded = Buffer.from(this.buildWindowsScriptContent(), 'utf16le').toString('base64');
        const argStr = `-NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
        const outerCmd = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '${argStr.replace(/'/g, "''")}'`;
        this.launcher = spawn(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', outerCmd],
          {
            windowsHide: true,
          }
        );
      } else {
        return false;
      }

      const launcher = this.launcher;
      launcher.on('error', (err) => {
        this.log?.('error', `特权守护进程启动失败: ${err.message}`);
      });
      launcher.on('exit', () => {
        // 守护进程已退出或用户取消了授权：清理可能残留的 PID 记录
        try {
          fs.unlinkSync(this.supPidFile());
        } catch {
          // 忽略
        }
        if (this.launcher === launcher) {
          this.launcher = null;
        }
      });
      return true;
    } catch (e: any) {
      this.log?.('error', `特权守护进程启动异常: ${e.message}`);
      return false;
    }
  }

  private buildWindowsScriptContent(): string {
    return buildWindowsScript(
      this.singboxPath,
      this.configPath,
      this.userDataPath,
      this.pidFilePath
    );
  }

  /**
   * 等待守护进程就绪（PID 文件出现）。
   * 若启动器以非 0 退出（用户取消授权等）则提前返回 false。
   */
  private waitForSupervisorReady(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      let interval: ReturnType<typeof setInterval>;

      const finish = (ok: boolean) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        clearInterval(interval);
        if (this.launcher) {
          this.launcher.removeListener('exit', onExit);
        }
        resolve(ok);
      };

      const onExit = (code: number | null) => {
        if (done) {
          return;
        }
        if (code !== null && code !== 0) {
          // 用户取消授权或启动失败
          this.log?.('warn', `特权守护进程启动被拒绝（退出码: ${code}）`);
          finish(false);
        } else {
          // 退出码 0：可能守护进程立即退出了，给短暂缓冲后再判定
          setTimeout(() => {
            if (!done) {
              finish(false);
            }
          }, 3000);
        }
      };

      timer = setTimeout(() => finish(false), timeoutMs);
      interval = setInterval(() => {
        this.isSupervisorAlive().then((alive) => {
          if (alive) {
            finish(true);
          }
        });
      }, 150);

      if (this.launcher) {
        this.launcher.on('exit', onExit);
      }
    });
  }
}
