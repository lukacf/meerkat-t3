use std::sync::Arc;

use meerkat_core::auth::PersistedAuthMode;
use meerkat_core::{AuthBindingRef, BindingId, BindingOrigin, RealmId};
use meerkat_providers::auth_store::{EphemeralTokenStore, InMemoryCoordinator};
use tokio::sync::oneshot;

use super::*;

const REDIRECT_URI: &str = "http://127.0.0.1/oauth/callback";
const OAUTH_PROVIDER: OAuthProviderIdentity = OAuthProviderIdentity::OpenAiChatGpt;

fn fixture(
    binding: &str,
) -> (
    DesktopProviderAuth,
    Arc<EphemeralTokenStore>,
    AuthCredentialIdentity,
) {
    let store = Arc::new(EphemeralTokenStore::new());
    let auth = DesktopProviderAuth {
        auth_scope: Ok(None),
        global_config_path: accounts::default_global_config_path(),
        copilot_accounts: Default::default(),
        account_mutations: Default::default(),
        auth_http: accounts::auth_http_client(),
        persistence: Ok(ProviderAuthPersistence::new(
            store.clone(),
            Arc::new(InMemoryCoordinator::new()),
        )),
        authority: meerkat_runtime::MeerkatMachine::ephemeral().provider_auth_runtime_authority(),
    };
    let identity = AuthCredentialIdentity::from_auth_binding(&AuthBindingRef {
        realm: RealmId::global(),
        binding: BindingId::parse(binding).expect("fixture binding"),
        profile: None,
        origin: BindingOrigin::Configured,
    });
    (auth, store, identity)
}

fn start(auth: &DesktopProviderAuth, identity: &AuthCredentialIdentity, verifier: &str) -> String {
    auth.authority
        .oauth_flow_authority()
        .start(
            identity.clone(),
            OAUTH_PROVIDER.into(),
            REDIRECT_URI.to_string(),
            verifier.to_string(),
        )
        .expect("admit fixture browser flow")
}

fn tokens(secret: &str) -> PersistedTokens {
    let now = Utc::now();
    PersistedTokens {
        auth_mode: PersistedAuthMode::ChatgptOauth,
        primary_secret: Some(secret.to_string()),
        refresh_token: Some("fixture-refresh-token".to_string()),
        id_token: None,
        expires_at: Some(now + chrono::Duration::hours(1)),
        last_refresh: Some(now),
        scopes: vec!["openid".to_string()],
        account_id: None,
        metadata: Value::Null,
    }
}

#[tokio::test]
async fn logout_invalidates_old_browser_flow_before_token_exchange() {
    let (auth, store, identity) = fixture("auth64_old_flow");
    let state = start(&auth, &identity, "old-verifier");

    auth.clear_tokens(identity.clone(), "openai")
        .await
        .expect("logout cancels an uncredentialed browser flow");

    let result = auth
        .complete_browser_flow(
            identity.clone(),
            state,
            OAUTH_PROVIDER,
            REDIRECT_URI.to_string(),
            |_| async { panic!("a logged-out flow must not contact the provider") },
        )
        .await;

    assert!(result.is_err(), "logout must revoke the old browser flow");
    assert!(store
        .load(&TokenKey::from_credential_identity(&identity))
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn logout_during_token_exchange_rejects_late_credential_publication() {
    let (auth, store, identity) = fixture("auth64_deferred_exchange");
    let state = start(&auth, &identity, "deferred-verifier");
    let (entered, exchange_entered) = oneshot::channel();
    let (release, exchange_released) = oneshot::channel();

    let completion = auth.complete_browser_flow(
        identity.clone(),
        state,
        OAUTH_PROVIDER,
        REDIRECT_URI.to_string(),
        |verifier| async move {
            assert_eq!(verifier, "deferred-verifier");
            entered.send(()).expect("observe exchange entry");
            exchange_released.await.expect("resume exchange");
            Ok(tokens("late-fixture-access-token"))
        },
    );
    let logout = async {
        exchange_entered
            .await
            .expect("exchange passed flow verification");
        auth.clear_tokens(identity.clone(), "openai")
            .await
            .expect("logout during exchange");
        assert!(store
            .load(&TokenKey::from_credential_identity(&identity))
            .await
            .unwrap()
            .is_none());
        release.send(()).expect("release the old exchange");
    };
    let (result, ()) = tokio::join!(completion, logout);

    assert!(result.is_err(), "late tokens cannot undo logout");
    assert!(store
        .load(&TokenKey::from_credential_identity(&identity))
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn newer_browser_flow_survives_logout_and_an_older_late_completion() {
    let (auth, store, identity) = fixture("auth64_newer_flow");
    let old_state = start(&auth, &identity, "old-verifier");
    let (entered, exchange_entered) = oneshot::channel();
    let (release, exchange_released) = oneshot::channel();

    let old_completion = auth.complete_browser_flow(
        identity.clone(),
        old_state,
        OAUTH_PROVIDER,
        REDIRECT_URI.to_string(),
        |verifier| async move {
            assert_eq!(verifier, "old-verifier");
            entered.send(()).expect("observe old exchange entry");
            exchange_released.await.expect("resume old exchange");
            Ok(tokens("obsolete-fixture-access-token"))
        },
    );
    let replacement = async {
        exchange_entered.await.expect("old exchange is pending");
        auth.clear_tokens(identity.clone(), "openai")
            .await
            .expect("logout retires old flow");
        let new_state = start(&auth, &identity, "new-verifier");
        let committed = auth
            .complete_browser_flow(
                identity.clone(),
                new_state.clone(),
                OAUTH_PROVIDER,
                REDIRECT_URI.to_string(),
                |verifier| async move {
                    assert_eq!(verifier, "new-verifier");
                    Ok(tokens("new-fixture-access-token"))
                },
            )
            .await
            .expect("a genuinely newer flow can publish credentials");
        assert!(meerkat_core::tokens_lifecycle_published(&committed));
        assert!(
            auth.authority
                .oauth_flow_authority()
                .verify(&new_state, &identity, OAUTH_PROVIDER.into(), REDIRECT_URI)
                .is_err(),
            "the successful flow must be consumed exactly once"
        );
        release.send(()).expect("release obsolete exchange");
        committed
    };
    let (old_result, committed) = tokio::join!(old_completion, replacement);

    assert!(old_result.is_err(), "old completion must remain revoked");
    assert_eq!(
        store
            .load(&TokenKey::from_credential_identity(&identity))
            .await
            .unwrap(),
        Some(committed),
        "late completion must neither replace nor clear the newer credential"
    );
}
