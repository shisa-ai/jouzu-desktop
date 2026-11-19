//! What kind of failure ended a reply.
//!
//! The runtime reports a provider's failure as text only (runtime request G6).
//! Until it gives a code, this is the one place that reads that text; every
//! client gets the code and keeps the original text for Details. Nothing else in
//! the host or the UI classifies provider text for a reply.

/// The code for a provider's failure text:
/// - `auth`: the key or sign-in was refused.
/// - `quota`: the account is out of credit or quota.
/// - `rate-limit`: too many requests for now.
/// - `model-unavailable`: the provider does not offer the model.
/// - `image`: the request was refused because of an image.
/// - `unavailable`: the provider or the network did not answer.
/// - `other`: anything else.
pub fn code(text: &str) -> &'static str {
    let lower = text.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|word| lower.contains(word));
    let status = |code: &str| {
        lower
            .match_indices(code)
            .any(|(at, _)| {
                let before = lower[..at].chars().next_back();
                let after = lower[at + code.len()..].chars().next();
                !before.is_some_and(|c| c.is_ascii_alphanumeric())
                    && !after.is_some_and(|c| c.is_ascii_alphanumeric())
            })
    };
    // A provider that names its error says what it is, whatever the status:
    // the Shisa router answers 403 for a model outside the plan and 429 for a
    // used-up free allowance, neither of which is a refused key or a pause.
    if has(&["model_not_in_plan"]) {
        return "model-unavailable";
    }
    if has(&["insufficient_balance", "free_allowance_exhausted"]) {
        return "quota";
    }
    if has(&["auth_verification_busy", "backend_at_capacity"]) {
        return "unavailable";
    }
    if status("401")
        || status("403")
        || has(&[
            "unauthorized",
            "unauthorised",
            "invalid api key",
            "invalid x-api-key",
            "incorrect api key",
            "api key not valid",
            "authentication",
            "security token",
            "not logged in",
            "access denied",
            "permission denied",
        ])
    {
        return "auth";
    }
    if has(&["insufficient_quota", "quota", "credit balance", "insufficient balance", "billing", "payment required"])
        || status("402")
    {
        return "quota";
    }
    if status("429") || has(&["rate limit", "rate_limit", "too many requests"]) {
        return "rate-limit";
    }
    if (status("404") && has(&["model"]))
        || has(&["model not found", "model_not_found", "does not exist", "not supported model", "unknown model"])
    {
        return "model-unavailable";
    }
    if has(&["image"]) {
        return "image";
    }
    if ["500", "502", "503", "504", "529"].iter().any(|code| status(code))
        || has(&[
            "overloaded",
            "service unavailable",
            "internal server error",
            "bad gateway",
            "timed out",
            "timeout",
            "econnreset",
            "econnrefused",
            "enotfound",
            "fetch failed",
            "network",
            "connection error",
            "socket hang up",
        ])
    {
        return "unavailable";
    }
    "other"
}

#[cfg(test)]
mod tests {
    use super::code;

    #[test]
    fn provider_texts_get_their_code() {
        assert_eq!(code("401 Unauthorized"), "auth");
        assert_eq!(code("UnrecognizedClientException: The security token included in the request is invalid."), "auth");
        assert_eq!(code("429: {\"code\":\"rate_limit_exceeded\",\"message\":\"Rate limit reached for requests.\"}"), "rate-limit");
        assert_eq!(code("You exceeded your current quota, please check your plan and billing details."), "quota");
        assert_eq!(code("404 {\"error\":{\"message\":\"The model `gone` does not exist\"}}"), "model-unavailable");
        assert_eq!(code("400 Invalid image: the image could not be decoded"), "image");
        assert_eq!(code("503 Service Unavailable"), "unavailable");
        assert_eq!(code("fetch failed"), "unavailable");
        assert_eq!(code("Connection error."), "unavailable");
        // Shisa router codes decide over the status they come with.
        assert_eq!(code("403 {\"error\":{\"message\":\"Model not in plan\",\"code\":\"model_not_in_plan\"}}"), "model-unavailable");
        assert_eq!(code("402 {\"error\":{\"code\":\"insufficient_balance\"}}"), "quota");
        assert_eq!(code("429 {\"error\":{\"code\":\"free_allowance_exhausted\"}}"), "quota");
        assert_eq!(code("429 {\"error\":{\"code\":\"rate_limit_exceeded\"}}"), "rate-limit");
        assert_eq!(code("503 {\"error\":{\"code\":\"auth_verification_busy\"}}"), "unavailable");
        assert_eq!(code("401 {\"error\":{\"message\":\"Invalid API key.\",\"code\":\"invalid_api_key\"}}"), "auth");
        assert_eq!(code("Something odd happened"), "other");
        // A number inside a longer one is not a status.
        assert_eq!(code("request 14010 failed"), "other");
    }
}
