//! 平台相关的小工具。

/// 系统是否正在关机/重启。
///
/// 关机过程中 Windows 会拒绝创建新进程（`CreateProcess` 失败，弹出
/// “应用程序无法正常启动 (0xc0000142)” 错误框）。退出/健康检查等后台路径
/// 在此时应跳过任何 spawn 子进程的操作（启动 sing-box、查询 DNS、拉起
/// 守护进程等），避免产生这些报错弹框。
#[cfg(target_os = "windows")]
pub fn system_is_shutting_down() -> bool {
    extern "system" {
        fn GetSystemMetrics(n_index: i32) -> i32;
    }
    // SM_SHUTTINGDOWN：当前会话正在关机时非零
    const SM_SHUTTINGDOWN: i32 = 0x2000;
    unsafe { GetSystemMetrics(SM_SHUTTINGDOWN) != 0 }
}

#[cfg(not(target_os = "windows"))]
pub fn system_is_shutting_down() -> bool {
    false
}
