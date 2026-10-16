use super::*;

#[tokio::test]
async fn failed_storage_acquisition_does_not_invent_an_observer_obligation() {
    let fixture = std::env::temp_dir().join(format!("observer-unopened-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&fixture).unwrap();
    let blocked_parent = fixture.join("not-a-directory");
    std::fs::write(&blocked_parent, b"blocked").unwrap();
    let database = blocked_parent.join("mob.sqlite");
    let layout = meerkat_mobkit::MetaStorageLayout::with_injected_roots(fixture.clone(), None);
    let registry = ProjectMobkitRegistry::new(HostToolTransport::new());

    assert!(
        open_mob_definition_storage(layout, &database, Some(&registry.observer_disposals),)
            .is_err()
    );
    assert!(registry.shutdown().await.is_empty());
    assert!(registry.drain_storage_observers().await.is_empty());
    assert!(registry.observer_disposals.lock().unwrap().is_empty());
    assert!(!database.exists());
    std::fs::remove_dir_all(fixture).unwrap();
}

#[tokio::test]
async fn cancellation_after_storage_acquisition_keeps_the_observer_obligation() {
    let fixture = std::env::temp_dir().join(format!("observer-partial-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&fixture).unwrap();
    let database = fixture.join("mob.sqlite");
    let layout = meerkat_mobkit::MetaStorageLayout::with_injected_roots(fixture.clone(), None);
    let registry = ProjectMobkitRegistry::new(HostToolTransport::new());
    let (acquired, acquisition) = tokio::sync::oneshot::channel();
    {
        let bootstrap = async {
            let storage =
                open_mob_definition_storage(layout, &database, Some(&registry.observer_disposals))
                    .unwrap();
            acquired.send(()).unwrap();
            std::future::pending::<()>().await;
            drop(storage);
        };
        tokio::pin!(bootstrap);
        tokio::select! {
            _ = acquisition => {}
            _ = &mut bootstrap => panic!("bootstrap should remain suspended"),
        }
        assert_eq!(registry.observer_disposals.lock().unwrap().len(), 1);
        // No runtime was admitted, but the suspended attempt still owns stores.
        assert!(registry.shutdown().await.is_empty());
        assert!(!registry.drain_storage_observers().await.is_empty());
    }
    // Cancellation drops the store, while the metadata survives for final drain.
    assert!(registry.drain_storage_observers().await.is_empty());
    assert!(
        database.exists(),
        "observer cleanup must preserve conversations"
    );
    std::fs::remove_dir_all(fixture).unwrap();
}
