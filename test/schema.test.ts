import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { isZodSchema, toJsonSchema, validateOutput } from "../src/schema.js";
import { AnthropicProvider } from "../src/providers/anthropic.js";
import { textMessage } from "../src/index.js";
import type { SchemaInput } from "../src/index.js";

test("detects zod schemas by duck typing", () => {
  assert.equal(isZodSchema(z.object({ a: z.string() }) as unknown as SchemaInput), true);
  assert.equal(isZodSchema({ type: "object" }), false);
});

test("converts zod schemas to JSON Schema, passes plain schemas through", async () => {
  const json = await toJsonSchema(z.object({ a: z.string() }) as unknown as SchemaInput);
  assert.equal(json.type, "object");
  assert.deepEqual((json.properties as Record<string, unknown>).a, { type: "string" });

  const plain = { type: "object", properties: {} };
  assert.equal(await toJsonSchema(plain), plain);
});

test("validateOutput runs zod parse and rejects mismatches", () => {
  const schema = z.object({ n: z.number() }) as unknown as SchemaInput;
  assert.deepEqual(validateOutput(schema, { n: 1 }), { n: 1 });
  assert.throws(() => validateOutput(schema, { n: "x" }));
});

test("zod structured output is validated end to end", async () => {
  const provider = new AnthropicProvider({
    apiKey: "sk-test",
    fetch: async () =>
      new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"name":"Jane","age":30}' }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      ),
  });
  const schema = z.object({ name: z.string(), age: z.number() });
  const result = await provider.generate({
    model: "claude-opus-4-8",
    messages: [textMessage("user", "extract")],
    output: { schema: schema as unknown as SchemaInput },
  });
  assert.deepEqual(result.output, { name: "Jane", age: 30 });
});
