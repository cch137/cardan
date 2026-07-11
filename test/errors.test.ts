import { test } from "node:test";
import assert from "node:assert/strict";

import {
  extractProviderError,
  streamCardanError,
} from "../src/errors.js";

test("extractProviderError: Anthropic nested error type + message", () => {
  const got = extractProviderError({
    type: "error",
    error: { type: "rate_limit_error", message: "usage limit reached" },
  });
  assert.equal(got.code, "rate_limit");
  assert.equal(got.message, "usage limit reached");
  assert.equal(got.type, "rate_limit_error");
});

test("extractProviderError: Anthropic auth without message keeps type in fallback", () => {
  const got = extractProviderError({
    type: "error",
    error: { type: "authentication_error" },
  });
  assert.equal(got.code, "auth");
  assert.equal(got.message, "stream error (authentication_error)");
});

test("extractProviderError: OpenAI Responses top-level message + code", () => {
  const got = extractProviderError({
    type: "error",
    code: "server_error",
    message: "The server had an error",
  });
  assert.equal(got.code, "server");
  assert.equal(got.message, "The server had an error");
  // event discriminator `type: "error"` must not become the error class
  assert.equal(got.type, "server_error");
});

test("extractProviderError: nested OpenAI-style error object", () => {
  const got = extractProviderError({
    error: { type: "image_generation_server_error", message: "Image generation failed" },
  });
  assert.equal(got.code, "server");
  assert.equal(got.message, "Image generation failed");
});

test("extractProviderError: overloaded and context-length from message", () => {
  assert.equal(
    extractProviderError({ error: { type: "overloaded_error", message: "busy" } }).code,
    "overloaded",
  );
  assert.equal(
    extractProviderError({
      error: { type: "invalid_request_error", message: "prompt is too long" },
    }).code,
    "context_length",
  );
});

test("extractProviderError: bare string", () => {
  const got = extractProviderError("  something broke  ");
  assert.equal(got.code, "unknown");
  assert.equal(got.message, "something broke");
});

test("extractProviderError: empty payload falls back to stream error", () => {
  const got = extractProviderError({});
  assert.equal(got.code, "server");
  assert.equal(got.message, "stream error");
});

test("streamCardanError: non-retryable with provider and raw", () => {
  const raw = {
    type: "error",
    error: { type: "rate_limit_error", message: "slow down" },
  };
  const err = streamCardanError(raw, "anthropic");
  assert.equal(err.code, "rate_limit");
  assert.equal(err.message, "slow down");
  assert.equal(err.provider, "anthropic");
  assert.equal(err.retryable, false);
  assert.equal(err.raw, raw);
});
