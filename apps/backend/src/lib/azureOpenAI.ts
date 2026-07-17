/**
 * Azure OpenAI Client
 * 
 * Wrapper for Azure OpenAI API using the working configuration
 * from azure-whatsapp-old project
 */

import { AzureOpenAI } from 'openai';
import { logger } from './logger.js';

export interface AzureOpenAIConfig {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  deploymentName: string;
  assistantId?: string;
  vectorStoreId?: string;
}

class AzureOpenAIService {
  private client: AzureOpenAI | null = null;
  private config: AzureOpenAIConfig | null = null;

  /**
   * Initialize Azure OpenAI client
   */
  initialize(): void {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2025-01-01-preview';
    const deploymentName = process.env.AZURE_OPENAI_DEPLOYMENT || 
                           process.env.AZURE_OPENAI_LLM_MODEL || 
                           'gpt-4o';

    if (!endpoint || !apiKey) {
      logger.warn('Azure OpenAI not configured - some features will be disabled');
      return;
    }

    try {
      this.config = {
        endpoint,
        apiKey,
        apiVersion,
        deploymentName,
        assistantId: process.env.AZURE_OPENAI_ASSISTANT_ID,
        vectorStoreId: process.env.AZURE_OPENAI_VECTOR_STORE_ID
      };

      this.client = new AzureOpenAI({
        apiKey,
        endpoint,
        apiVersion,
        deployment: deploymentName
      });

      logger.info('✅ Azure OpenAI initialized', {
        endpoint: endpoint.substring(0, 40) + '...',
        deployment: deploymentName,
        hasAssistant: !!this.config.assistantId,
        hasVectorStore: !!this.config.vectorStoreId
      });
    } catch (error) {
      logger.error('Failed to initialize Azure OpenAI:', error);
      this.client = null;
    }
  }

  /**
   * Get the Azure OpenAI client
   */
  getClient(): AzureOpenAI {
    if (!this.client) {
      throw new Error('Azure OpenAI client not initialized. Check your environment variables.');
    }
    return this.client;
  }

  /**
   * Check if Azure OpenAI is available
   */
  isAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Get current configuration
   */
  getConfig(): AzureOpenAIConfig | null {
    return this.config;
  }

  /**
   * Generate chat completion.
   * Pass `model: 'mini'` to use the cheaper gpt-4o-mini deployment for Q&A / simple tasks.
   * Omit (or pass `model: 'default'`) for the standard GPT-4o deployment.
   */
  async createChatCompletion(params: {
    messages: Array<{ role: string; content: string }>;
    temperature?: number;
    maxTokens?: number;
    stream?: boolean;
    model?: 'default' | 'mini';
  }) {
    const client = this.getClient();

    // Resolve deployment name: mini uses AZURE_OPENAI_MINI_DEPLOYMENT if set,
    // otherwise falls back to the default deployment.
    const deploymentName =
      params.model === 'mini'
        ? (process.env.AZURE_OPENAI_MINI_DEPLOYMENT || this.config!.deploymentName)
        : this.config!.deploymentName;

    // Reasoning-class models (gpt-5*, o*) reject max_tokens and non-default temperature
    const isReasoningModel = /^(gpt-5|o\d)/i.test(deploymentName);
    return await client.chat.completions.create({
      model: deploymentName,
      messages: params.messages as any,
      ...(isReasoningModel
        ? { max_completion_tokens: params.maxTokens || 500 }
        : { temperature: params.temperature ?? 0.7, max_tokens: params.maxTokens || 500 }),
      stream: params.stream || false
    } as any);
  }

  /**
   * Create or retrieve an assistant thread
   */
  async createThread() {
    const client = this.getClient();
    return await client.beta.threads.create();
  }

  /**
   * Add a message to a thread
   */
  async addMessageToThread(threadId: string, content: string) {
    const client = this.getClient();
    return await client.beta.threads.messages.create(threadId, {
      role: 'user',
      content
    });
  }

  /**
   * Run assistant on a thread (RAG-powered response)
   */
  async runAssistant(threadId: string, assistantId?: string) {
    const client = this.getClient();
    const actualAssistantId = assistantId || this.config!.assistantId;

    if (!actualAssistantId) {
      throw new Error('No assistant ID configured');
    }

    return await client.beta.threads.runs.create(threadId, {
      assistant_id: actualAssistantId
    });
  }

  /**
   * Wait for run to complete and get response
   */
  async waitForRunCompletion(threadId: string, runId: string, maxWaitSeconds: number = 30) {
    const client = this.getClient();
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitSeconds * 1000) {
      const run = await client.beta.threads.runs.retrieve(threadId, runId);

      if (run.status === 'completed') {
        const messages = await client.beta.threads.messages.list(threadId);
        const assistantMessages = messages.data.filter(m => m.role === 'assistant');
        
        if (assistantMessages.length > 0) {
          const latestMessage = assistantMessages[0];
          const content = latestMessage.content[0];
          
          if (content.type === 'text') {
            return content.text.value;
          }
        }
        throw new Error('No assistant response found');
      }

      if (['failed', 'cancelled', 'expired'].includes(run.status)) {
        throw new Error(`Run ${run.status}: ${run.last_error?.message || 'Unknown error'}`);
      }

      // Wait 1 second before checking again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error('Run timeout - assistant took too long to respond');
  }

  /**
   * Generate embeddings (for document search)
   */
  async createEmbedding(text: string) {
    const client = this.getClient();
    const embeddingModel = process.env.AZURE_OPENAI_EMBEDDING_MODEL || 'text-embedding-ada-002';
    
    return await client.embeddings.create({
      model: embeddingModel,
      input: text
    });
  }

  /**
   * Transcribe audio using Whisper
   */
  async transcribeAudio(audioFile: any) {
    const client = this.getClient();
    const whisperModel = process.env.AZURE_OPENAI_WHISPER_MODEL || 'whisper';
    
    return await client.audio.transcriptions.create({
      file: audioFile,
      model: whisperModel
    });
  }
}

// Export singleton instance
export const azureOpenAI = new AzureOpenAIService();

// Initialize on import
azureOpenAI.initialize();
