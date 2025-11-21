import fs from "fs/promises";
import path from "path";

const apiKey = "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";

export async function generateResponse(
  prompt: string, 
  controller: ReadableStreamDefaultController
) {
  const encoder = new TextEncoder();
  const enqueue = controller.enqueue.bind(controller);
  const close = controller.close.bind(controller);
  
  try {
    console.log("Loading system prompt...");
    const systemPrompt = await getSystemPrompt();
    
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        "model": "qwen/qwen3-coder:free",
        "messages": [
          { "role": "system", "content": systemPrompt },
          { "role": "user", "content": prompt }
        ],
        "stream": true
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter API error: ${response.statusText} - ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Failed to get response body reader");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.substring(6);
          if (data.trim() === "[DONE]") {
            continue;
          }
          try {
            const json = JSON.parse(data);
            const chunkText = json.choices[0]?.delta?.content;
            if (chunkText) {
              const sse = `data: ${JSON.stringify({ text: chunkText })}\n\n`;
              enqueue(encoder.encode(sse));
            }
          } catch (e) {
            // Ignore parse errors for now
          }
        }
      }
    }

    enqueue(encoder.encode(`data: [DONE]\n\n`));

  } catch (error) {
    console.error("OpenRouter error:", error);
    enqueue(encoder.encode(`data: ${JSON.stringify({ error: (error as Error).message })}\n\n`));
  } finally {
    close();
  }
}

async function getSystemPrompt(): Promise<string> {
  const promptPath = path.join(process.cwd(), 'system-prompt.md');
  try {
    return await fs.readFile(promptPath, 'utf-8');
  } catch (error) {
    console.error("Error reading system prompt:", error);
    return "You are an expert full-stack software engineer.";
  }
}
