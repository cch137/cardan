import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeMessages } from "../src/normalize.js";
import { CardanError, textMessage } from "../src/index.js";
import type { Message } from "../src/index.js";

test("merges consecutive same-role messages", () => {
  const result = normalizeMessages([
    textMessage("user", "a"),
    textMessage("user", "b"),
    textMessage("assistant", "c"),
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    role: "user",
    content: [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ],
  });
});

test("relocates tool results after their calls, in call order", () => {
  const messages: Message[] = [
    textMessage("user", "q"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        { type: "tool_call", id: "c1", name: "a", args: {} },
        { type: "tool_call", id: "c2", name: "b", args: {} },
      ],
    },
    textMessage("user", "interleaved"),
    {
      role: "tool",
      content: [
        { type: "tool_result", callId: "c2", result: "r2" },
        { type: "tool_result", callId: "c1", result: "r1" },
      ],
    },
  ];
  const result = normalizeMessages(messages);
  assert.equal(result[2]!.role, "tool");
  assert.deepEqual(result[2]!.content, [
    { type: "tool_result", callId: "c1", result: "r1" },
    { type: "tool_result", callId: "c2", result: "r2" },
  ]);
  assert.deepEqual(result[3], textMessage("user", "interleaved"));
});

test("synthesizes error results for dangling tool calls", () => {
  const result = normalizeMessages([
    textMessage("user", "q"),
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "c1", name: "a", args: {} }],
    },
  ]);
  assert.deepEqual(result[2], {
    role: "tool",
    content: [
      {
        type: "tool_result",
        callId: "c1",
        result: "tool call produced no result",
        isError: true,
      },
    ],
  });
});

test("throws on orphan tool_result", () => {
  assert.throws(
    () =>
      normalizeMessages([
        {
          role: "tool",
          content: [{ type: "tool_result", callId: "missing", result: "x" }],
        },
      ]),
    (error: unknown) =>
      error instanceof CardanError && error.code === "invalid_request",
  );
});

test("throws on duplicate tool_result for the same call", () => {
  assert.throws(
    () =>
      normalizeMessages([
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "c1", name: "a", args: {} }],
        },
        {
          role: "tool",
          content: [
            { type: "tool_result", callId: "c1", result: "x" },
            { type: "tool_result", callId: "c1", result: "y" },
          ],
        },
      ]),
    (error: unknown) =>
      error instanceof CardanError && error.code === "invalid_request",
  );
});

test("drops blank unsigned text parts (image-only messages)", () => {
  const result = normalizeMessages([
    {
      role: "user",
      content: [
        { type: "image", mimeType: "image/png", data: new URL("https://x.test/a.png") },
        { type: "text", text: "" },
      ],
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.content.length, 1);
  assert.equal(result[0]!.content[0]!.type, "image");
});

test("drops a message left with no parts after blank-text filtering", () => {
  const result = normalizeMessages([
    textMessage("user", "hi"),
    textMessage("assistant", "yo"),
    { role: "user", content: [{ type: "text", text: "  \n" }] },
  ]);
  assert.equal(result.length, 2);
});

test("keeps blank text parts that carry a signature", () => {
  const result = normalizeMessages([
    {
      role: "assistant",
      content: [{ type: "text", text: "", signature: "sig" }],
    },
  ]);
  assert.deepEqual(result[0]!.content, [{ type: "text", text: "", signature: "sig" }]);
});
