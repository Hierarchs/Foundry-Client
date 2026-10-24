use serde_json::{Value, json};
use std::collections::HashSet;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

/// Sample only on demand. There is no idle polling thread, timer, or HTTP ping.
pub struct Metrics {
    system: System,
    root: Pid,
    cores: f64,
    ram_gb: u64,
}
impl Metrics {
    pub fn new() -> Self {
        let mut system = System::new();
        system.refresh_memory();
        let ram_gb = system.total_memory().div_ceil(1024 * 1024 * 1024);
        let mut metrics = Self {
            system,
            root: Pid::from_u32(std::process::id()),
            cores: std::thread::available_parallelism().map_or(1, |n| n.get()) as f64,
            ram_gb,
        };
        metrics.sample(); // Establish a CPU delta baseline before the first UI request.
        metrics
    }
    pub fn ram_gb(&self) -> u64 {
        self.ram_gb
    }
    pub fn sample(&mut self) -> Value {
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_memory().with_cpu(),
        );
        let mut family = HashSet::from([self.root]);
        loop {
            let previous = family.len();
            for (pid, process) in self.system.processes() {
                if process.parent().is_some_and(|p| family.contains(&p)) {
                    family.insert(*pid);
                }
            }
            if previous == family.len() {
                break;
            }
        }
        let mut bytes = 0_u64;
        let mut cpu = 0_f64;
        let mut count = 0;
        for pid in family {
            if let Some(process) = self.system.process(pid) {
                bytes += process.memory();
                cpu += process.cpu_usage() as f64;
                count += 1;
            }
        }
        json!({ "memoryMB": (bytes as f64 / 1024.0 / 1024.0).round(), "cpuPercent": (cpu / self.cores * 10.0).round() / 10.0, "processCount": count })
    }
}
