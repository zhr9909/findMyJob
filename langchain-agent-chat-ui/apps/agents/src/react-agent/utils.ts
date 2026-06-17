import { initChatModel } from "langchain/chat_models/universal";
import { ChatOpenAI } from "@langchain/openai";

/**
 * Load a chat model from a fully specified name.
 * @param fullySpecifiedName - String in the format 'provider/model' or 'provider/account/provider/model'.
 * @returns A Promise that resolves to a BaseChatModel instance.
 */
export async function loadChatModel(
  fullySpecifiedName: string,
): Promise<ReturnType<typeof initChatModel>> {
  const openAIApiKey = process.env.OPENAI_API_KEY ?? process.env.AI_API_KEY;
  const configuration = {
    model: fullySpecifiedName,
    temperature: 0.25,
    apiKey: openAIApiKey,
    configuration: {
      baseURL:
        process.env.OPENAI_BASE_URL ??
        process.env.AI_BASE_URL ??
        process.env.AI_API_BASE?.replace(/\/chat\/completions$/, ""),
    },
    timeout: Number(process.env.MODEL_TIMEOUT ?? 60) * 1000,
  };

  if (
    openAIApiKey &&
    (process.env.AI_API_BASE ||
      process.env.OPENAI_BASE_URL ||
      fullySpecifiedName.includes("deepseek") ||
      fullySpecifiedName.includes("gpt"))
  ) {
    return new ChatOpenAI(configuration) as unknown as ReturnType<
      typeof initChatModel
    >;
  }

  const index = fullySpecifiedName.indexOf("/");
  if (index === -1) {
    // If there's no "/", assume it's just the model
    return await initChatModel(fullySpecifiedName);
  } else {
    const provider = fullySpecifiedName.slice(0, index);
    const model = fullySpecifiedName.slice(index + 1);
    return await initChatModel(model, { modelProvider: provider });
  }
}
