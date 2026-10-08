//! App ingress for durable native images. Bytes stay out of persisted timelines.
use std::sync::Arc;

use base64::Engine;
use meerkat_core::{
    types::{ContentBlock, ContentInput, ImageData},
    BlobId,
};
use meerkat_mobkit::BinaryBlobStore;
use serde_json::{json, Value};

use crate::{
    console_expected_target, object_params, required_nonempty_string, GatewayError, MeerkatGateway,
};

pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub const MAX_IMAGES_PER_MESSAGE: usize = 8;

pub fn validate_image(media_type: &str, encoded: &str) -> Result<(String, Vec<u8>), String> {
    let media_type = meerkat_core::image_generation::MediaType::canonical_str(media_type);
    if !matches!(
        media_type.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    ) {
        return Err("Expected a PNG, JPEG, GIF, or WebP image".into());
    }
    if encoded.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err("Image exceeds the 10 MiB limit".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "Image payload is not valid base64")?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image must contain between 1 byte and 10 MiB".into());
    }
    let valid = match media_type.as_str() {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        _ => false,
    };
    if !valid {
        return Err("Image bytes do not match the declared media type".into());
    }
    Ok((media_type, bytes))
}

pub fn parse_content(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<ContentInput, GatewayError> {
    let input: ContentInput =
        serde_json::from_value(params.get(key).cloned().unwrap_or(Value::Null))
            .map_err(|_| GatewayError::invalid("Expected text or native content blocks", None))?;
    let blocks = input.clone().into_blocks();
    let mut images = 0;
    for block in &blocks {
        match block {
            ContentBlock::Text { .. } => {}
            ContentBlock::Image {
                data: ImageData::Blob { blob_id },
                ..
            } if meerkat_mobkit::blob_store::is_valid_blob_id(blob_id) => images += 1,
            _ => {
                return Err(GatewayError::invalid(
                    "Upload images first and send their durable blob references",
                    None,
                ))
            }
        }
    }
    if images > MAX_IMAGES_PER_MESSAGE {
        return Err(GatewayError::invalid(
            "A message supports up to 8 images",
            None,
        ));
    }
    if images == 0 && input.text_content().trim().is_empty() {
        return Err(GatewayError::invalid(
            "A message needs text or an image",
            None,
        ));
    }
    Ok(input)
}

pub async fn validate_content(
    store: Option<Arc<dyn BinaryBlobStore>>,
    input: &ContentInput,
) -> Result<(), GatewayError> {
    for block in input.clone().into_blocks() {
        if let ContentBlock::Image {
            media_type,
            data: ImageData::Blob { blob_id },
        } = block
        {
            let store = store
                .as_ref()
                .ok_or_else(|| GatewayError::policy("Native image storage is unavailable", None))?;
            let payload = read_verified(store.as_ref(), &blob_id).await?;
            if payload.0 != media_type {
                return Err(GatewayError::invalid(
                    "Image reference media type does not match its stored blob",
                    None,
                ));
            }
        }
    }
    Ok(())
}

async fn read_verified(
    store: &dyn BinaryBlobStore,
    blob_id: &BlobId,
) -> Result<(String, String, usize), GatewayError> {
    if !store.is_persistent() {
        return Err(GatewayError::policy(
            "Durable native image storage is unavailable",
            None,
        ));
    }
    if !meerkat_mobkit::blob_store::is_valid_blob_id(blob_id) {
        return Err(GatewayError::invalid("Invalid image blob id", None));
    }
    let payload = store.get_bytes(blob_id).await.map_err(|error| {
        GatewayError::policy(
            "Native image could not be read",
            Some(json!({"error":error.to_string()})),
        )
    })?;
    if payload.data.len() > MAX_IMAGE_BYTES {
        return Err(GatewayError::invalid(
            "Image exceeds the 10 MiB limit",
            None,
        ));
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(&payload.data);
    let (media_type, bytes) = validate_image(&payload.media_type, &encoded)
        .map_err(|error| GatewayError::invalid(error, None))?;
    if meerkat_core::blob::content_blob_id(&media_type, &encoded) != *blob_id
        || payload.size != bytes.len() as u64
    {
        return Err(GatewayError::policy(
            "Native image content address verification failed",
            None,
        ));
    }
    Ok((media_type, encoded, bytes.len()))
}

impl MeerkatGateway {
    async fn media_store(
        &self,
        params: &serde_json::Map<String, Value>,
    ) -> Result<(String, Arc<dyn BinaryBlobStore>), GatewayError> {
        let mob_id = required_nonempty_string(params, "mobId")?;
        let mob = self.mob_for_params(params, &mob_id).await?;
        let store = if params.get("expected").is_some() {
            let expected = console_expected_target(params)?;
            mob.validate_console_incarnation(&expected)
                .await
                .map_err(|error| {
                    GatewayError::conflict(
                        "Image agent target is not current",
                        Some(json!({"error":error})),
                    )
                })?;
            mob.console
                .as_ref()
                .ok_or_else(|| GatewayError::policy("Native console unavailable", None))?
                .binary_blob_store_for_identity(&expected.identity)
                .await
                .map_err(|error| {
                    GatewayError::policy(
                        "Native agent image storage unavailable",
                        Some(json!({"error":error.to_string()})),
                    )
                })?
        } else {
            mob.runtime
                .as_ref()
                .and_then(|runtime| runtime.mob_runtime().binary_blob_store())
        }
        .ok_or_else(|| GatewayError::policy("Native image storage is unavailable", None))?;
        if !store.is_persistent() {
            return Err(GatewayError::policy(
                "Durable native image storage is unavailable",
                None,
            ));
        }
        Ok((mob_id, store))
    }

    pub(crate) async fn mobs_image_upload(
        &self,
        params: Option<&Value>,
    ) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let media_type = required_nonempty_string(params, "mediaType")?;
        let encoded = required_nonempty_string(params, "dataBase64")?;
        let (media_type, bytes) = validate_image(&media_type, &encoded)
            .map_err(|error| GatewayError::invalid(error, None))?;
        let (mob_id, store) = self.media_store(params).await?;
        let blob = meerkat_mobkit::blob_store::put_meerkat_image_bytes(
            store.as_ref(),
            &media_type,
            bytes.into(),
        )
        .await
        .map_err(|error| {
            GatewayError::policy(
                "Native image could not be stored",
                Some(json!({"error":error.to_string()})),
            )
        })?;
        let (_, _, size) = read_verified(store.as_ref(), &blob.blob_id).await?;
        Ok(
            json!({"mobId":mob_id,"blob":{"blobId":blob.blob_id,"mediaType":media_type,"size":size}}),
        )
    }

    pub(crate) async fn mobs_image_read(
        &self,
        params: Option<&Value>,
    ) -> Result<Value, GatewayError> {
        let params = object_params(params)?;
        let blob_id = BlobId::new(required_nonempty_string(params, "blobId")?);
        // Read the configured durable scope directly. Viewing saved images never admits or
        // resumes an agent and remains possible after its live incarnation has retired.
        let mob_id = crate::required_mob_id(params)?;
        let locator = crate::derive_project_locator(
            &required_nonempty_string(params, "projectPath")?,
            Some(&required_nonempty_string(params, "stateRoot")?),
        )?;
        let root = locator
            .state_root
            .join("mobkit")
            .join(crate::stable_slug(&mob_id))
            .join("blobs");
        if !root.is_dir() {
            return Err(GatewayError::policy(
                "Durable native images are unavailable for this conversation",
                None,
            ));
        }
        let store = meerkat_mobkit::ObjectStoreBlobStore::local(root).map_err(|error| {
            GatewayError::policy(
                "Native image store could not be opened",
                Some(json!({"error":error.to_string()})),
            )
        })?;
        let (media_type, encoded, size) = read_verified(&store, &blob_id).await?;
        Ok(
            json!({"mobId":mob_id,"blob":{"blobId":blob_id,"mediaType":media_type,"size":size},"dataBase64":encoded}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn images_reject_mime_mismatch_invalid_base64_and_oversize() {
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nfixture");
        assert!(validate_image("image/png", &png).is_ok());
        assert!(validate_image("image/jpeg", &png).is_err());
        assert!(validate_image("image/svg+xml", &png).is_err());
        assert!(validate_image("image/png", "!broken").is_err());
        assert!(validate_image(
            "image/png",
            &"A".repeat(MAX_IMAGE_BYTES.div_ceil(3) * 4 + 1)
        )
        .is_err());
    }
    #[tokio::test]
    async fn native_image_address_survives_store_reopen_and_content_validation() {
        let path =
            std::env::temp_dir().join(format!("meerkat-media-test-{}", uuid::Uuid::new_v4()));
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        let store = meerkat_mobkit::ObjectStoreBlobStore::local(path.clone()).unwrap();
        let blob = meerkat_mobkit::blob_store::put_meerkat_image_bytes(
            &store,
            "image/png",
            bytes.to_vec().into(),
        )
        .await
        .unwrap();
        drop(store);
        let reopened = Arc::new(meerkat_mobkit::ObjectStoreBlobStore::local(path.clone()).unwrap());
        let input = parse_content(&json!({"input":[{"type":"image","media_type":"image/png","source":"blob","blob_id":blob.blob_id}]}).as_object().unwrap(),"input").unwrap();
        validate_content(Some(reopened.clone()), &input)
            .await
            .unwrap();
        assert_eq!(
            read_verified(reopened.as_ref(), &blob.blob_id)
                .await
                .unwrap()
                .2,
            bytes.len()
        );
        let wrong = parse_content(&json!({"input":[{"type":"image","media_type":"image/jpeg","source":"blob","blob_id":blob.blob_id}]}).as_object().unwrap(),"input").unwrap();
        assert!(validate_content(Some(reopened), &wrong).await.is_err());
        assert!(parse_content(&json!({"input":[{"type":"image","media_type":"image/png","source":"inline","data":"abc"}]}).as_object().unwrap(),"input").is_err());
        std::fs::remove_dir_all(path).unwrap();
    }
}

/// Console persistence is a projection boundary: retain content identity, never live inline bytes.
/// The native session owner externalizes the same address into its configured blob store.
pub fn reference_inline_images(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(reference_inline_images),
        Value::Object(object) => {
            if object.get("type").and_then(Value::as_str) == Some("image")
                && object.get("source").and_then(Value::as_str) == Some("inline")
            {
                if let (Some(media), Some(data)) = (
                    object.get("media_type").and_then(Value::as_str),
                    object.get("data").and_then(Value::as_str),
                ) {
                    if validate_image(media, data).is_ok() {
                        let blob_id = meerkat_core::blob::content_blob_id(media, data);
                        object.insert("blob_id".into(), json!(blob_id));
                        object.insert("source".into(), json!("blob"));
                        object.remove("data");
                    } else {
                        object.remove("data");
                        object.insert(
                            "image_error".into(),
                            json!("Image payload was invalid or too large"),
                        );
                    }
                }
            }
            for child in object.values_mut() {
                reference_inline_images(child);
            }
        }
        _ => {}
    }
}

pub struct MediaConsolePolicy {
    pub include_workers: bool,
}
impl meerkat_mobkit::ConsoleVisibilityPolicy for MediaConsolePolicy {
    fn include_implicit_delegate_members(&self) -> bool {
        self.include_workers
    }
    fn member_visible(&self, member: &meerkat_mobkit::runtime::ConsoleMember) -> bool {
        self.include_workers
            || meerkat_mobkit::ConsoleVisibilityPolicy::member_visible(
                &meerkat_mobkit::HideImplicitDelegateMembersConsoleVisibilityPolicy,
                member,
            )
    }
    fn identity_visible(&self, record: &meerkat_mobkit::ConsoleIdentityRecord) -> bool {
        self.include_workers
            || meerkat_mobkit::ConsoleVisibilityPolicy::identity_visible(
                &meerkat_mobkit::HideImplicitDelegateMembersConsoleVisibilityPolicy,
                record,
            )
    }
    fn redact_payload(&self, frame: &meerkat_mobkit::NewConsoleFrame) -> Option<Value> {
        let mut payload = frame.payload.clone();
        reference_inline_images(&mut payload);
        (payload != frame.payload).then_some(payload)
    }
}
