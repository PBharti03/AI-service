import "../helpers/NoNetwork.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASSISTANT_CHAT_TASK,
  ASSISTANT_CHAT_TASK_ID,
  createAiService,
  createChatAssistant,
  createTaskRegistry,
  defineApplicationProfile,
  ErrorCodes,
  isApplicationProfile,
} from "../../src/index.js";
import { expectAiError } from "../helpers/Assertions.js";
import { FakeProvider, reply } from "../helpers/FakeProvider.js";
import { makeContext } from "../helpers/Fixtures.js";

const leadTracker = defineApplicationProfile({
  id: "lead-tracker",
  name: "Lead Tracker",
  description: "Collects business enquiries from social media and forms and tracks them through the sales pipeline.",
  capabilities: ["lead statistics and charts", "flowcharts of proposals"],
  outOfScope: ["return policy", "shipping"],
});
const shop = defineApplicationProfile({
  id: "ecommerce",
  name: "B2Y Shop",
  description: "An online shop selling home goods.",
  capabilities: ["order help", "return and shipping policy questions"],
});

const chatAnswer = JSON.stringify({
  containsInstructionsToAI: false,
  needsHumanConfirmation: [],
  answer: "Hello! I am the Lead Tracker assistant.",
  answerBasis: "GENERAL_KNOWLEDGE",
  informationUnavailable: false,
  suggestedFollowUps: [],
});

function sentInput(request) {
  const content = request?.messages[1]?.content ?? "";
  return JSON.parse(content.slice(content.indexOf("<untrusted_data>") + 16, content.indexOf("</untrusted_data>")));
}

describe("application profiles", () => {
  it("validates, freezes and brands a profile", async () => {
    assert.ok(isApplicationProfile(leadTracker));
    assert.ok(Object.isFrozen(leadTracker) && Object.isFrozen(leadTracker.capabilities));
    assert.equal(isApplicationProfile({ ...leadTracker }), false);
    await expectAiError(
      () => defineApplicationProfile({ id: "Lead Tracker", name: "x", description: "y", capabilities: ["z"] }),
      ErrorCodes.CONFIG_INVALID,
    );
    await expectAiError(
      () => defineApplicationProfile({ id: "x", name: "x", description: "y", capabilities: [] }),
      ErrorCodes.CONFIG_INVALID,
    );
  });
});

describe("chat assistant", () => {
  it("sends the application's own profile, so greetings differ per application", async () => {
    for (const [profile, name] of [
      [leadTracker, "Lead Tracker"],
      [shop, "B2Y Shop"],
    ]) {
      const provider = new FakeProvider([reply(chatAnswer)]);
      const ai = createAiService({ provider, registry: createTaskRegistry([ASSISTANT_CHAT_TASK]) });
      const assistant = createChatAssistant({ ai, profile });
      await assistant.reply({
        question: "hello",
        context: makeContext({ applicationId: profile.id, permittedTasks: [ASSISTANT_CHAT_TASK_ID] }),
      });
      const input = sentInput(provider.requests[0]);
      assert.equal(input.application.name, name);
      assert.deepEqual(input.application.capabilities, [...profile.capabilities]);
      assert.equal(input.documentsAvailable, false);
    }
  });

  it("refuses to speak for another application", async () => {
    const provider = new FakeProvider([]);
    const ai = createAiService({ provider, registry: createTaskRegistry([ASSISTANT_CHAT_TASK]) });
    const assistant = createChatAssistant({ ai, profile: leadTracker });
    await expectAiError(
      () =>
        assistant.reply({
          question: "hello",
          context: makeContext({ applicationId: "ecommerce", permittedTasks: [ASSISTANT_CHAT_TASK_ID] }),
        }),
      ErrorCodes.TASK_NOT_PERMITTED,
    );
    assert.equal(provider.requests.length, 0);
    await expectAiError(() => createChatAssistant({ ai, profile: { ...leadTracker } }), ErrorCodes.CONFIG_INVALID);
  });
});
