//! PrivilegedSupervisor 移植（对应 `src/main/services/PrivilegedSupervisor.ts`）。
//!
//! TUN 模式一次授权、常驻提权守护进程接管 sing-box 生命周期。
//! 协议（文件位于 userData 目录）：
//! - flowz_cmd           命令内容：start | stop | restart | quit
//! - flowz_seq           单调递增序列号，守护进程仅在变化时处理
//! - flowz_supervisor.pid   守护进程自身 PID
//! - flowz_supervisor.log    守护进程日志
//! - flowz_supervisor.singpath  sing-box 路径指纹（跨会话复用校验）

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tokio::process::Command;

pub type SupervisorCommand = &'static str;
pub const CMD_START: SupervisorCommand = "start";
pub const CMD_STOP: SupervisorCommand = "stop";
pub const CMD_RESTART: SupervisorCommand = "restart";
pub const CMD_QUIT: SupervisorCommand = "quit";

const IDLE_TIMEOUT_SECONDS: u32 = 1800;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// macOS / Linux 通用的 bash 守护进程脚本（与 TS buildUnixScript 语义一致）
pub fn build_unix_script(
    singbox_path: &str,
    config_path: &str,
    user_data_path: &str,
    pid_file_path: &str,
) -> String {
    let q = shell_quote;
    [
        "#!/bin/bash",
        "# FlowZ Privileged Supervisor (Unix) - 由单次管理员授权启动，持续接管 sing-box 生命周期",
        &format!("SINGBOX_PATH={}", q(singbox_path)),
        &format!("USERDATA={}", q(user_data_path)),
        &format!("CONFIG_PATH={}", q(config_path)),
        "",
        &format!("PID_FILE={}", q(pid_file_path)),
        "SUP_PID_FILE=\"$USERDATA/flowz_supervisor.pid\"",
        "CMD_FILE=\"$USERDATA/flowz_cmd\"",
        "SEQ_FILE=\"$USERDATA/flowz_seq\"",
        "LOG_FILE=\"$USERDATA/flowz_supervisor.log\"",
        &format!("IDLE_TIMEOUT={}", IDLE_TIMEOUT_SECONDS),
        "",
        "log() {",
        "  echo \"[$(date '+%Y-%m-%d %H:%M:%S')] $1\" >> \"$LOG_FILE\" 2>/dev/null || true",
        "}",
        "",
        "if [ \"$(id -u)\" != \"0\" ]; then",
        "  log \"supervisor must run as root\"",
        "  exit 1",
        "fi",
        "",
        "echo $$ > \"$SUP_PID_FILE\" 2>/dev/null || true",
        "log \"supervisor started PID=$$\"",
        "",
        "SBPID=\"\"",
        "last_seq=\"\"",
        "last_cmd_time=$(date +%s)",
        "",
        "stop_singbox() {",
        "  local pid=\"\"",
        "  local is_child=\"\"",
        "  if [ -n \"$SBPID\" ]; then",
        "    pid=\"$SBPID\"",
        "    is_child=\"1\"",
        "  elif [ -f \"$PID_FILE\" ]; then",
        "    pid=$(cat \"$PID_FILE\" 2>/dev/null || echo \"\")",
        "  fi",
        "  if [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then",
        "    log \"stopping sing-box PID=$pid (SIGTERM)\"",
        "    kill -TERM \"$pid\" 2>/dev/null",
        "    local i=0",
        "    while [ $i -lt 30 ] && kill -0 \"$pid\" 2>/dev/null; do sleep 0.2; i=$((i+1)); done",
        "    if kill -0 \"$pid\" 2>/dev/null; then",
        "      log \"sing-box still alive, SIGKILL PID=$pid\"",
        "      kill -9 \"$pid\" 2>/dev/null",
        "      sleep 0.5",
        "    fi",
        "    if [ -n \"$is_child\" ]; then",
        "      wait \"$pid\" 2>/dev/null",
        "    fi",
        "  fi",
        "  rm -f \"$PID_FILE\" 2>/dev/null",
        "  SBPID=\"\"",
        "  log \"sing-box stopped\"",
        "}",
        "",
        "cleanup_stale() {",
        "  local pids=\"\"",
        "  pids=$(/usr/bin/pgrep -f 'sing-box' 2>/dev/null || echo \"\")",
        "  local p",
        "  for p in $pids; do",
        "    if [ -n \"$p\" ] && [ \"$p\" != \"$$\" ] && kill -0 \"$p\" 2>/dev/null; then",
        "      log \"killing stale sing-box PID=$p\"",
        "      kill -9 \"$p\" 2>/dev/null || true",
        "    fi",
        "  done",
        "  sleep 0.3",
        "}",
        "",
        "start_singbox() {",
        "  stop_singbox",
        "  cleanup_stale",
        "  log \"starting sing-box\"",
        "  \"$SINGBOX_PATH\" run -c \"$CONFIG_PATH\" >/dev/null 2>&1 &",
        "  SBPID=$!",
        "  echo \"$SBPID\" > \"$PID_FILE\" 2>/dev/null || true",
        "  chmod 644 \"$PID_FILE\" 2>/dev/null || true",
        "  log \"sing-box started PID=$SBPID\"",
        "}",
        "",
        "while true; do",
        "  if [ -n \"$SBPID\" ] && ! kill -0 \"$SBPID\" 2>/dev/null; then",
        "    log \"sing-box PID=$SBPID exited unexpectedly\"",
        "    wait \"$SBPID\" 2>/dev/null",
        "    SBPID=\"\"",
        "    rm -f \"$PID_FILE\" 2>/dev/null",
        "  fi",
        "",
        "  cur_seq=\"\"",
        "  if [ -f \"$SEQ_FILE\" ]; then",
        "    cur_seq=$(cat \"$SEQ_FILE\" 2>/dev/null || echo \"\")",
        "  fi",
        "",
        "  if [ -n \"$cur_seq\" ] && [ \"$cur_seq\" != \"$last_seq\" ]; then",
        "    last_seq=\"$cur_seq\"",
        "    cmd=\"\"",
        "    if [ -f \"$CMD_FILE\" ]; then",
        "      cmd=$(cat \"$CMD_FILE\" 2>/dev/null || echo \"\")",
        "    fi",
        "    case \"$cmd\" in",
        "      start)",
        "        start_singbox",
        "        ;;",
        "      stop)",
        "        stop_singbox",
        "        ;;",
        "      restart)",
        "        stop_singbox",
        "        start_singbox",
        "        ;;",
        "      quit)",
        "        log \"quit command received\"",
        "        stop_singbox",
        "        rm -f \"$SUP_PID_FILE\" \"$PID_FILE\" 2>/dev/null",
        "        log \"supervisor exiting\"",
        "        exit 0",
        "        ;;",
        "      *)",
        "        log \"unknown command: $cmd\"",
        "        ;;",
        "    esac",
        "    last_cmd_time=$(date +%s)",
        "  fi",
        "",
        "  now=$(date +%s)",
        "  if [ -z \"$SBPID\" ] && [ $((now - last_cmd_time)) -ge \"$IDLE_TIMEOUT\" ]; then",
        "    log \"idle timeout, exiting\"",
        "    rm -f \"$SUP_PID_FILE\" \"$PID_FILE\" 2>/dev/null",
        "    exit 0",
        "  fi",
        "",
        "  sleep 0.25",
        "done",
    ]
    .join("\n")
}

/// Windows PowerShell 守护进程脚本（与 TS buildWindowsScript 语义一致）
pub fn build_windows_script(
    singbox_path: &str,
    config_path: &str,
    user_data_path: &str,
    pid_file_path: &str,
) -> String {
    let p = |s: &str| s.replace('\'', "''");
    [
        "# FlowZ Privileged Supervisor (Windows) - 由单次 UAC 授权启动",
        "$ErrorActionPreference = 'SilentlyContinue'",
        "",
        &format!("$singbox = '{}'", p(singbox_path)),
        &format!("$userData = '{}'", p(user_data_path)),
        &format!("$config = '{}'", p(config_path)),
        &format!("$pidFile = '{}'", p(pid_file_path)),
        "$supPidFile = \"$userData\\flowz_supervisor.pid\"",
        "$cmdFile = \"$userData\\flowz_cmd\"",
        "$seqFile = \"$userData\\flowz_seq\"",
        "$logFile = \"$userData\\flowz_supervisor.log\"",
        &format!("$idleTimeout = {}", IDLE_TIMEOUT_SECONDS),
        "",
        "function Log([string]$msg) {",
        "  Add-Content -Path $logFile -Value (\"[{0}] {1}\" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg) -Encoding UTF8",
        "}",
        "",
        "$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
        "if (-not $isAdmin) {",
        "  Log 'supervisor must run as administrator'",
        "  exit 1",
        "}",
        "",
        "Set-Content -Path $supPidFile -Value $PID -Encoding ASCII -Force",
        "Log (\"supervisor started PID={0}\" -f $PID)",
        "",
        "$script:sbPid = 0",
        "$script:lastSeq = ''",
        "$script:idleStart = Get-Date",
        "",
        "function Stop-Singbox {",
        "  $target = $script:sbPid",
        "  if ($target -le 0 -and (Test-Path $pidFile)) {",
        "    $content = Get-Content $pidFile -Raw -ErrorAction SilentlyContinue",
        "    if ($content) {",
        "      try { [int]$target = $content.Trim() } catch { $target = 0 }",
        "    }",
        "  }",
        "  if ($target -gt 0) {",
        "    $proc = Get-Process -Id $target -ErrorAction SilentlyContinue",
        "    if ($proc) {",
        "      Log (\"stopping sing-box PID={0}\" -f $target)",
        "      Stop-Process -Id $target -Force -ErrorAction SilentlyContinue",
        "      Start-Sleep -Milliseconds 500",
        "    }",
        "  }",
        "  Remove-Item $pidFile -ErrorAction SilentlyContinue",
        "  $script:sbPid = 0",
        "  Log 'sing-box stopped'",
        "}",
        "",
        "function Start-Singbox {",
        "  Stop-Singbox",
        "  Get-Process -Name 'sing-box' -ErrorAction SilentlyContinue | ForEach-Object {",
        "    Log (\"killing stale sing-box PID={0}\" -f $_.Id)",
        "    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue",
        "  }",
        "  Start-Sleep -Milliseconds 300",
        "  Log 'starting sing-box'",
        "  $psi = New-Object System.Diagnostics.ProcessStartInfo",
        "  $psi.FileName = $singbox",
        "  $psi.Arguments = \"run -c `\"$config`\"\"",
        "  $psi.UseShellExecute = $false",
        "  $psi.CreateNoWindow = $true",
        "  $p = [System.Diagnostics.Process]::Start($psi)",
        "  $script:sbPid = $p.Id",
        "  Set-Content -Path $pidFile -Value $script:sbPid -Encoding ASCII -Force",
        "  Log (\"sing-box started PID={0}\" -f $script:sbPid)",
        "  $script:idleStart = Get-Date",
        "}",
        "",
        "while ($true) {",
        "  if ($script:sbPid -gt 0) {",
        "    $alive = Get-Process -Id $script:sbPid -ErrorAction SilentlyContinue",
        "    if (-not $alive) {",
        "      Log (\"sing-box PID={0} exited unexpectedly\" -f $script:sbPid)",
        "      Remove-Item $pidFile -ErrorAction SilentlyContinue",
        "      $script:sbPid = 0",
        "    }",
        "  }",
        "",
        "  $curSeq = ''",
        "  if (Test-Path $seqFile) {",
        "    $curSeq = (Get-Content $seqFile -Raw -ErrorAction SilentlyContinue).Trim()",
        "  }",
        "",
        "  if ($curSeq -ne '' -and $curSeq -ne $script:lastSeq) {",
        "    $script:lastSeq = $curSeq",
        "    $cmd = ''",
        "    if (Test-Path $cmdFile) {",
        "      $cmd = (Get-Content $cmdFile -Raw -ErrorAction SilentlyContinue).Trim()",
        "    }",
        "    switch ($cmd) {",
        "      'start'   { Start-Singbox }",
        "      'stop'    { Stop-Singbox }",
        "      'restart' { Stop-Singbox; Start-Singbox }",
        "      'quit'    { Log 'quit command received'; Stop-Singbox; Remove-Item $supPidFile,$pidFile -ErrorAction SilentlyContinue; Log 'supervisor exiting'; exit 0 }",
        "      default   { Log (\"unknown command: {0}\" -f $cmd) }",
        "    }",
        "    $script:idleStart = Get-Date",
        "  }",
        "",
        "  if ($script:sbPid -le 0) {",
        "    $idleSecs = ((Get-Date) - $script:idleStart).TotalSeconds",
        "    if ($idleSecs -ge $idleTimeout) {",
        "      Log 'idle timeout, exiting'",
        "      Remove-Item $supPidFile -ErrorAction SilentlyContinue",
        "      exit 0",
        "    }",
        "  }",
        "  Start-Sleep -Milliseconds 250",
        "}",
    ]
    .join("\n")
}

pub struct PrivilegedSupervisor {
    singbox_path: PathBuf,
    config_path: PathBuf,
    user_data_dir: PathBuf,
    pid_file_path: PathBuf,
    command_seq: u64,
}

impl PrivilegedSupervisor {
    pub fn new(
        singbox_path: PathBuf,
        config_path: PathBuf,
        user_data_dir: PathBuf,
        pid_file_path: PathBuf,
    ) -> Self {
        PrivilegedSupervisor {
            singbox_path,
            config_path,
            user_data_dir,
            pid_file_path,
            command_seq: 0,
        }
    }

    fn cmd_file(&self) -> PathBuf {
        self.user_data_dir.join("flowz_cmd")
    }
    fn seq_file(&self) -> PathBuf {
        self.user_data_dir.join("flowz_seq")
    }
    fn sup_pid_file(&self) -> PathBuf {
        self.user_data_dir.join("flowz_supervisor.pid")
    }
    fn singpath_file(&self) -> PathBuf {
        self.user_data_dir.join("flowz_supervisor.singpath")
    }
    fn script_file(&self) -> PathBuf {
        #[cfg(target_os = "windows")]
        return self.user_data_dir.join("flowz_supervisor.ps1");
        #[cfg(not(target_os = "windows"))]
        return self.user_data_dir.join("flowz_supervisor.sh");
    }

    fn read_pid(&self, file: &Path) -> Option<u32> {
        std::fs::read_to_string(file)
            .ok()
            .and_then(|c| c.trim().parse::<u32>().ok())
            .filter(|&p| p > 0)
    }

    fn is_process_alive(&self, pid: u32) -> bool {
        #[cfg(unix)]
        {
            unsafe { libc::kill(pid as i32, 0) == 0 }
        }
        #[cfg(target_os = "windows")]
        {
            // 保守判断：tasklist 查询
            std::process::Command::new("tasklist")
                .args(["/FI", &format!("PID eq {}", pid), "/NH"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
                .unwrap_or(false)
        }
        #[cfg(not(any(unix, target_os = "windows")))]
        {
            let _ = pid;
            false
        }
    }

    pub fn is_supervisor_alive(&self) -> bool {
        self.read_pid(&self.sup_pid_file())
            .map(|pid| self.is_process_alive(pid))
            .unwrap_or(false)
    }

    /// sing-box 的实际 PID（守护进程写入的 pid 文件）
    pub fn singbox_pid(&self) -> Option<u32> {
        self.read_pid(&self.pid_file_path)
            .filter(|&pid| self.is_process_alive(pid))
    }

    fn fingerprint_matches(&self) -> bool {
        std::fs::read_to_string(self.singpath_file())
            .map(|c| !c.trim().is_empty() && c.trim() == self.singbox_path.to_string_lossy())
            .unwrap_or(false)
    }

    fn next_seq(&mut self) -> String {
        self.command_seq += 1;
        format!(
            "{:x}-{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            std::process::id(),
            self.command_seq
        )
    }

    /// 确保守护进程运行：可复用则复用，否则单次授权拉起
    pub async fn ensure_started(&mut self) -> Result<bool, String> {
        if self.is_supervisor_alive() && self.fingerprint_matches() {
            return Ok(true);
        }
        if self.is_supervisor_alive() {
            // 指纹不匹配：让旧守护进程退出重建
            let _ = self.shutdown().await;
        }
        // 清理过期协议文件（保留 singbox.pid 供新守护进程清理旧进程）
        for f in [self.sup_pid_file(), self.cmd_file(), self.seq_file()] {
            let _ = std::fs::remove_file(f);
        }
        std::fs::write(self.singpath_file(), self.singbox_path.to_string_lossy().as_bytes())
            .map_err(|e| format!("写入指纹文件失败: {}", e))?;
        self.write_script()?;
        self.launch_supervisor()?;
        Ok(self.wait_for_ready().await)
    }

    /// 下发命令
    pub fn send_command(&mut self, cmd: SupervisorCommand) -> Result<(), String> {
        let seq = self.next_seq();
        std::fs::write(self.cmd_file(), cmd).map_err(|e| format!("写入命令失败: {}", e))?;
        std::fs::write(self.seq_file(), seq).map_err(|e| format!("写入序列号失败: {}", e))?;
        Ok(())
    }

    /// 等待 sing-box PID 文件出现（start 命令下发后）
    pub async fn wait_for_singbox_pid(&self, timeout: Duration) -> Option<u32> {
        let start = Instant::now();
        while start.elapsed() < timeout {
            if let Some(pid) = self.singbox_pid() {
                return Some(pid);
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        None
    }

    /// 停止守护进程（先下发 quit，8s 后仍存活则放弃）
    pub async fn shutdown(&mut self) -> Result<(), String> {
        if !self.is_supervisor_alive() {
            return Ok(());
        }
        let _ = self.send_command(CMD_QUIT);
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(8) {
            if !self.is_supervisor_alive() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Ok(())
    }

    fn write_script(&self) -> Result<(), String> {
        let content = {
            #[cfg(target_os = "windows")]
            {
                build_windows_script(
                    &self.singbox_path.to_string_lossy(),
                    &self.config_path.to_string_lossy(),
                    &self.user_data_dir.to_string_lossy(),
                    &self.pid_file_path.to_string_lossy(),
                )
            }
            #[cfg(not(target_os = "windows"))]
            {
                build_unix_script(
                    &self.singbox_path.to_string_lossy(),
                    &self.config_path.to_string_lossy(),
                    &self.user_data_dir.to_string_lossy(),
                    &self.pid_file_path.to_string_lossy(),
                )
            }
        };
        std::fs::write(self.script_file(), content)
            .map_err(|e| format!("写入守护进程脚本失败: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(
                self.script_file(),
                std::fs::Permissions::from_mode(0o755),
            );
        }
        Ok(())
    }

    fn launch_supervisor(&self) -> Result<(), String> {
        #[cfg(not(target_os = "windows"))]
        let script = self.script_file();
        #[cfg(target_os = "macos")]
        {
            Command::new("/usr/bin/osascript")
                .arg("-e")
                .arg(format!(
                    "do shell script \"/bin/bash {}\" with administrator privileges",
                    shell_quote(&script.to_string_lossy())
                ))
                .spawn()
                .map_err(|e| format!("osascript 启动失败: {}", e))?;
        }
        #[cfg(target_os = "linux")]
        {
            Command::new("/usr/bin/pkexec")
                .arg("/bin/bash")
                .arg(&script)
                .spawn()
                .map_err(|e| format!("pkexec 启动失败（可能未安装）: {}", e))?;
        }
        #[cfg(target_os = "windows")]
        {
            // 通过 -EncodedCommand 传参避免引号问题（与 TS 一致）
            let content = build_windows_script(
                &self.singbox_path.to_string_lossy(),
                &self.config_path.to_string_lossy(),
                &self.user_data_dir.to_string_lossy(),
                &self.pid_file_path.to_string_lossy(),
            );
            let encoded = base64_encode_utf16le(&content);
            let arg_str = format!("-NoProfile -ExecutionPolicy Bypass -EncodedCommand {}", encoded);
            let outer = format!(
                "Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '{}'",
                arg_str.replace('\'', "''")
            );
            Command::new("powershell.exe")
                .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &outer])
                .spawn()
                .map_err(|e| format!("PowerShell UAC 启动失败: {}", e))?;
        }
        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        {
            let _ = script;
            return Err("不支持的平台".to_string());
        }
        Ok(())
    }

    async fn wait_for_ready(&self) -> bool {
        let start = Instant::now();
        while start.elapsed() < STARTUP_TIMEOUT {
            if self.is_supervisor_alive() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        false
    }
}

/// Windows -EncodedCommand 需要的 UTF-16LE base64（避免引入新依赖，手写）
fn base64_encode_utf16le(s: &str) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut bytes: Vec<u8> = Vec::with_capacity(s.len() * 2);
    for c in s.encode_utf16() {
        bytes.push((c & 0xff) as u8);
        bytes.push((c >> 8) as u8);
    }
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((n >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unix_script_contains_protocol() {
        let s = build_unix_script("/opt/sb/sing-box", "/cfg.json", "/ud", "/ud/singbox.pid");
        assert!(s.starts_with("#!/bin/bash"));
        assert!(s.contains("flowz_cmd"));
        assert!(s.contains("flowz_seq"));
        assert!(s.contains("flowz_supervisor.pid"));
        assert!(s.contains("'/opt/sb/sing-box'"));
        assert!(s.contains("IDLE_TIMEOUT=1800"));
        // 关键行为：清理残留、SIGTERM→SIGKILL、空闲退出
        assert!(s.contains("cleanup_stale"));
        assert!(s.contains("kill -9"));
        assert!(s.contains("idle timeout"));
    }

    #[test]
    fn windows_script_contains_protocol() {
        let s = build_windows_script("C:\\sb\\sing-box.exe", "C:\\cfg.json", "C:\\ud", "C:\\ud\\sb.pid");
        assert!(s.contains("flowz_supervisor.pid"));
        assert!(s.contains("IsInRole"));
        assert!(s.contains("Start-Singbox"));
    }

    #[test]
    fn utf16le_base64_roundtrip_shape() {
        // "A" -> UTF-16LE [0x41, 0x00] -> "QQA="
        assert_eq!(base64_encode_utf16le("A"), "QQA=");
    }

    #[test]
    fn pid_file_paths() {
        let sup = PrivilegedSupervisor::new(
            PathBuf::from("/sb"),
            PathBuf::from("/cfg"),
            PathBuf::from("/ud"),
            PathBuf::from("/ud/singbox.pid"),
        );
        assert_eq!(sup.cmd_file(), PathBuf::from("/ud/flowz_cmd"));
        assert_eq!(sup.seq_file(), PathBuf::from("/ud/flowz_seq"));
        assert_eq!(sup.sup_pid_file(), PathBuf::from("/ud/flowz_supervisor.pid"));
    }

    #[test]
    fn next_seq_monotonic() {
        let mut sup = PrivilegedSupervisor::new(
            PathBuf::from("/sb"),
            PathBuf::from("/cfg"),
            PathBuf::from("/ud"),
            PathBuf::from("/ud/singbox.pid"),
        );
        let a = sup.next_seq();
        let b = sup.next_seq();
        assert_ne!(a, b);
    }
}
