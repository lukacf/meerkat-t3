use std::path::PathBuf;

use meerkat_mob::store::{SqliteMobObserverDrain, SqliteMobObserverDrainRefused, SqliteMobStores};
use meerkat_mobkit::MetaStorageLayout;
use tokio::{sync::Mutex, task::JoinHandle};

type MobStoreObserverDrainResult = Result<SqliteMobObserverDrain, SqliteMobObserverDrainRefused>;

/// Observer cleanup after all runtime, store and reader handles are released.
/// Retains path metadata only. Success covers this process's listed observers,
/// not other database users, later openers, or permission to delete storage.
pub(super) struct MobStoreObserverDisposal {
    layout: MetaStorageLayout,
    root_database: PathBuf,
    task: Mutex<ObserverDrainTask>,
}

#[derive(Default)]
struct ObserverDrainTask {
    worker: Option<JoinHandle<Result<DrainAttempt, String>>>,
    // Keep the exact discovery scope and native results, including refusals.
    last_attempt: Option<Result<DrainAttempt, String>>,
    complete: bool,
    panic_failure: Option<String>,
}

#[derive(Debug)]
struct DrainAttempt {
    databases: Vec<PathBuf>,
    results: Vec<(PathBuf, MobStoreObserverDrainResult)>,
}

impl MobStoreObserverDisposal {
    pub(super) fn new(layout: MetaStorageLayout, root_database: PathBuf) -> Self {
        Self {
            layout,
            root_database,
            task: Mutex::new(ObserverDrainTask::default()),
        }
    }

    pub(super) async fn drain(&self) -> Result<(), String> {
        self.drain_with(discover_and_drain).await
    }

    // The worker argument is also a test seam for a blocked physical drain.
    async fn drain_with(
        &self,
        drain: impl FnOnce(MetaStorageLayout, PathBuf) -> Result<DrainAttempt, String> + Send + 'static,
    ) -> Result<(), String> {
        let mut task = self.task.lock().await;
        if let Some(error) = &task.panic_failure {
            return Err(error.clone());
        }
        if task.complete {
            return Ok(());
        }
        if task.worker.is_none() {
            let layout = self.layout.clone();
            let root_database = self.root_database.clone();
            task.worker = Some(tokio::task::spawn_blocking(move || {
                drain(layout, root_database)
            }));
        }
        // Await by reference: cancelling or timing out this caller releases the
        // mutex but leaves the same blocking worker available to the next call.
        let joined = task.worker.as_mut().expect("retained observer drain").await;
        // No await between observing completion and recording its outcome.
        task.worker.take();
        let attempt = match joined {
            Ok(attempt) => attempt,
            Err(error) => {
                let error = format!(
                    "Mob store observer drain task failed before proving completion: {error}"
                );
                task.panic_failure = Some(error.clone());
                return Err(error);
            }
        };
        let outcome = match &attempt {
            Ok(attempt) => attempt.outcome(),
            Err(error) => Err(error.clone()),
        };
        // A later NotFound cannot erase an observed native worker panic.
        if attempt
            .as_ref()
            .is_ok_and(DrainAttempt::has_panicked_worker)
        {
            task.panic_failure = outcome.as_ref().err().cloned();
        }
        task.complete = outcome.is_ok();
        task.last_attempt = Some(attempt);
        // Ordinary completed failures can be retried after owners are dropped
        // or discovery is repaired. A running worker is never replaced.
        outcome
    }
}

fn discover_and_drain(
    layout: MetaStorageLayout,
    root_database: PathBuf,
) -> Result<DrainAttempt, String> {
    let databases = observer_paths(&layout, root_database)?;
    let results = databases
        .iter()
        .map(|path| (path.clone(), SqliteMobStores::drain_observers(path)))
        .collect();
    Ok(DrainAttempt { databases, results })
}

fn observer_paths(
    layout: &MetaStorageLayout,
    root_database: PathBuf,
) -> Result<Vec<PathBuf>, String> {
    let child_root = layout.child_mob_root();
    let discovery_error = |error: std::io::Error| {
        format!(
            "Mob store observer discovery failed at {}: {error}",
            child_root.display()
        )
    };
    // Meta owns this exact directory. We do not reproduce its private child
    // filenames or classify storage: every regular file is offered to Core's
    // process-local observer registry, which returns NotFound for non-stores.
    // No database is opened and no file is changed or removed by this census.
    let entries = match std::fs::read_dir(&child_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(vec![root_database]);
        }
        Err(error) => return Err(discovery_error(error)),
    };
    let mut children = Vec::new();
    for entry in entries {
        let entry = entry.map_err(&discovery_error)?;
        // file_type does not follow symlinks out of the owned child root.
        if entry.file_type().map_err(&discovery_error)?.is_file() {
            children.push(entry.path());
        }
    }
    children.sort();
    children.retain(|path| path != &root_database);
    let mut databases = vec![root_database];
    databases.extend(children);
    Ok(databases)
}

impl DrainAttempt {
    fn has_panicked_worker(&self) -> bool {
        self.results.iter().any(|(_, result)| {
            matches!(result, Ok(SqliteMobObserverDrain::Closed(report)) if report.panicked_workers > 0)
        })
    }

    fn outcome(&self) -> Result<(), String> {
        let mut failures = Vec::new();
        if self.databases.len() != self.results.len()
            || self
                .databases
                .iter()
                .zip(&self.results)
                .any(|(expected, (returned, _))| expected != returned)
        {
            failures.push(format!(
                "returned database scope differs from discovery: expected {:?}, returned {:?}",
                self.databases,
                self.results
                    .iter()
                    .map(|(path, _)| path)
                    .collect::<Vec<_>>()
            ));
        }
        for (path, result) in &self.results {
            match result {
                Ok(SqliteMobObserverDrain::NotFound) => {}
                Ok(SqliteMobObserverDrain::Closed(report))
                    if report.catch_up_settled
                        && report.unjoined_workers == 0
                        && report.joining_elsewhere == 0
                        && !report.replacement_registered
                        && report.panicked_workers == 0 => {}
                _ => failures.push(format!("{}: {result:?}", path.display())),
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Mob store observer cleanup did not complete: {}",
                failures.join("; ")
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use meerkat_mob::store::SqliteMobObserverDrainReport;
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc, Arc,
        },
        time::Duration,
    };
    use tokio::sync::oneshot;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("mob-observer-drain-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn disposal(&self) -> MobStoreObserverDisposal {
            MobStoreObserverDisposal::new(
                MetaStorageLayout::with_injected_roots(self.0.clone(), None),
                self.0.join("root-mob.db"),
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn discovery_uses_the_owned_root_without_guessing_database_names() {
        let fixture = Fixture::new();
        let disposal = fixture.disposal();
        let child_root = disposal.layout.child_mob_root();
        std::fs::create_dir_all(child_root.join("nested")).unwrap();
        let unusual_store = child_root.join("native-store-without-extension");
        std::fs::write(&unusual_store, b"").unwrap();
        std::fs::write(child_root.join("nested/ignored"), b"").unwrap();
        assert_eq!(
            observer_paths(&disposal.layout, disposal.root_database.clone()).unwrap(),
            [disposal.root_database, unusual_store],
        );
    }

    #[cfg(unix)]
    #[test]
    fn discovery_does_not_follow_symlinks_out_of_the_owned_root() {
        let fixture = Fixture::new();
        let disposal = fixture.disposal();
        let child_root = disposal.layout.child_mob_root();
        std::fs::create_dir_all(&child_root).unwrap();
        let outside = fixture.0.join("outside.sqlite");
        std::fs::write(&outside, b"").unwrap();
        std::os::unix::fs::symlink(outside, child_root.join("linked.sqlite")).unwrap();
        assert_eq!(
            observer_paths(&disposal.layout, disposal.root_database.clone()).unwrap(),
            [disposal.root_database],
        );
    }

    #[tokio::test]
    async fn held_child_reader_refuses_then_retry_drains_the_exact_scope() {
        let fixture = Fixture::new();
        let disposal = fixture.disposal();
        drop(SqliteMobStores::open(&disposal.root_database).unwrap());
        let child_root = disposal.layout.child_mob_root();
        std::fs::create_dir_all(&child_root).unwrap();
        let child = child_root.join("mob--held.db");
        let stores = SqliteMobStores::open(&child).unwrap();
        let reader = stores.event_store();
        drop(stores);

        let (scope_sender, scope_receiver) = oneshot::channel();
        let error = disposal
            .drain_with(move |layout, root| {
                let attempt = discover_and_drain(layout, root)?;
                scope_sender.send(attempt.databases.clone()).unwrap();
                Ok(attempt)
            })
            .await
            .unwrap_err();
        let attempted_scope = scope_receiver.await.unwrap();
        assert!(error.contains(child.to_str().unwrap()), "{error}");
        // SQLite workers can add or remove sidecars after discovery. The
        // retained attempt must match its own census, not a later directory
        // listing. Exercise that distinction without depending on SQLite timing.
        let later_file = child_root.join("arrived-after-first-drain");
        std::fs::write(&later_file, b"").unwrap();
        assert!(!attempted_scope.contains(&later_file));
        {
            let task = disposal.task.lock().await;
            let attempt = task.last_attempt.as_ref().unwrap().as_ref().unwrap();
            assert_eq!(attempt.databases, attempted_scope);
            assert_eq!(
                attempt
                    .results
                    .iter()
                    .map(|(path, _)| path)
                    .collect::<Vec<_>>(),
                attempt.databases.iter().collect::<Vec<_>>()
            );
            assert_eq!(attempt.databases.first(), Some(&disposal.root_database));
            assert!(attempt.databases.contains(&child));
            let child_result = attempt
                .results
                .iter()
                .find(|(path, _)| path == &child)
                .unwrap();
            assert!(matches!(
                &child_result.1,
                Err(SqliteMobObserverDrainRefused::OtherOwners { .. })
            ));
            assert!(task.worker.is_none());
            assert!(!task.complete);
        }
        drop(reader);
        disposal.drain().await.unwrap();
        {
            let task = disposal.task.lock().await;
            assert!(task.complete);
            let attempt = task.last_attempt.as_ref().unwrap().as_ref().unwrap();
            assert_eq!(attempt.databases.first(), Some(&disposal.root_database));
            assert!(attempt.databases.contains(&child));
            assert!(attempt.databases.contains(&later_file));
            assert!(attempt.outcome().is_ok());
        }
        assert!(disposal.root_database.exists());
        assert!(child.exists());
    }

    #[tokio::test]
    async fn discovery_failure_preserves_the_failure_and_can_be_retried() {
        let fixture = Fixture::new();
        let disposal = fixture.disposal();
        drop(SqliteMobStores::open(&disposal.root_database).unwrap());
        let child_root = disposal.layout.child_mob_root();
        std::fs::write(&child_root, b"not a directory").unwrap();

        let error = disposal.drain().await.unwrap_err();
        assert!(error.contains("discovery failed"), "{error}");
        assert!(error.contains(child_root.to_str().unwrap()), "{error}");
        assert_eq!(
            disposal
                .task
                .lock()
                .await
                .last_attempt
                .as_ref()
                .unwrap()
                .as_ref()
                .unwrap_err(),
            &error
        );
        std::fs::remove_file(&child_root).unwrap();
        disposal.drain().await.unwrap();
        assert!(disposal.root_database.exists());
    }

    #[tokio::test]
    async fn unresolved_path_is_not_absence_and_can_be_retried_after_repair() {
        let fixture = Fixture::new();
        let disposal = fixture.disposal();
        disposal.drain().await.unwrap_err();
        {
            let task = disposal.task.lock().await;
            let attempt = task.last_attempt.as_ref().unwrap().as_ref().unwrap();
            assert!(matches!(
                attempt.results[0].1,
                Err(SqliteMobObserverDrainRefused::UnresolvedPath { .. })
            ));
            assert!(!task.complete);
        }
        std::fs::write(&disposal.root_database, b"").unwrap();
        disposal.drain().await.unwrap();
    }

    #[tokio::test]
    async fn timeout_retains_the_same_blocking_worker_for_retry() {
        let fixture = Fixture::new();
        let disposal = fixture.disposal();
        std::fs::write(&disposal.root_database, b"").unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let worker_calls = Arc::clone(&calls);
        let (entered, started) = oneshot::channel();
        let (release, released) = mpsc::channel();
        {
            let first = disposal.drain_with(move |layout, root| {
                worker_calls.fetch_add(1, Ordering::SeqCst);
                entered.send(()).unwrap();
                released.recv().unwrap();
                discover_and_drain(layout, root)
            });
            tokio::pin!(first);
            tokio::select! {
                _ = started => {}
                result = &mut first => panic!("drain completed while held: {result:?}"),
            }
            assert!(tokio::time::timeout(Duration::from_millis(10), first)
                .await
                .is_err());
            // End the scope to drop the pinned caller future and its mutex guard.
        }
        assert!(disposal.task.lock().await.worker.is_some());
        release.send(()).unwrap();
        disposal
            .drain_with(|_, _| panic!("timeout must not replace the worker"))
            .await
            .unwrap();
        disposal
            .drain_with(|_, _| panic!("completion must not create a worker"))
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn worker_join_panic_is_sticky() {
        let fixture = Fixture::new();
        let disposal = fixture.disposal();
        let error = disposal
            .drain_with(|_, _| panic!("drain panic"))
            .await
            .unwrap_err();
        assert_eq!(disposal.drain().await.unwrap_err(), error);
        assert!(!disposal.task.lock().await.complete);
    }

    fn closed_attempt(report: SqliteMobObserverDrainReport) -> DrainAttempt {
        let path = PathBuf::from("root-mob.db");
        DrainAttempt {
            databases: vec![path.clone()],
            results: vec![(path, Ok(SqliteMobObserverDrain::Closed(report)))],
        }
    }

    fn settled_report() -> SqliteMobObserverDrainReport {
        SqliteMobObserverDrainReport {
            catch_up_settled: true,
            joined_workers: 1,
            panicked_workers: 0,
            unjoined_workers: 0,
            joining_elsewhere: 0,
            replacement_registered: false,
        }
    }

    #[test]
    fn every_incomplete_closed_report_is_refused() {
        let settled = settled_report();
        closed_attempt(settled).outcome().unwrap();
        for report in [
            SqliteMobObserverDrainReport {
                catch_up_settled: false,
                ..settled
            },
            SqliteMobObserverDrainReport {
                unjoined_workers: 1,
                ..settled
            },
            SqliteMobObserverDrainReport {
                joining_elsewhere: 1,
                ..settled
            },
            SqliteMobObserverDrainReport {
                replacement_registered: true,
                ..settled
            },
            SqliteMobObserverDrainReport {
                panicked_workers: 1,
                ..settled
            },
        ] {
            assert!(closed_attempt(report).outcome().is_err(), "{report:?}");
        }
    }

    #[tokio::test]
    async fn a_native_worker_panic_cannot_be_hidden_by_a_later_not_found() {
        let fixture = Fixture::new();
        let disposal = fixture.disposal();
        let error = disposal
            .drain_with(|_, _| {
                Ok(closed_attempt(SqliteMobObserverDrainReport {
                    panicked_workers: 1,
                    ..settled_report()
                }))
            })
            .await
            .unwrap_err();
        assert_eq!(
            disposal
                .drain_with(|_, _| panic!("panic evidence is sticky"))
                .await
                .unwrap_err(),
            error
        );
    }
}
