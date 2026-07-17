/**
 * Q&A Service
 * 
 * Handles Socratic learning Q&A using Azure OpenAI
 * Uses lazy imports to avoid circular dependencies
 */

import { llmChat, llmAvailable } from '../lib/llm.js';
import { azureOpenAI } from '../lib/azureOpenAI.js'; // retained for RAG embeddings
import { logger } from '../lib/logger.js';

// Lazy imports
const getDb = () => import('@ekatra/database').then(m => m.db);
const getMessaging = () => import('@ekatra/messaging').then(m => m.messaging);

export class QAService {
  private readonly maxTurns = 5;

  /**
   * Sanitise learner-supplied text before including it in an LLM prompt.
   * Strips common prompt-injection patterns and enforces a character limit.
   */
  private sanitizeInput(input: string): string {
    // Hard length cap — WhatsApp messages are short; anything longer is suspicious
    const truncated = input.slice(0, 500);

    // Strip phrases that attempt to override the system prompt
    const injectionPatterns = [
      /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?|rules?)/gi,
      /disregard\s+(all\s+)?(previous|above|prior)/gi,
      /you\s+are\s+now\s+/gi,
      /act\s+as\s+(if\s+you\s+are\s+|a\s+)?(?!alfred)/gi, // allow "act as Alfred" but not arbitrary role changes
      /system\s*:\s*/gi,
      /assistant\s*:\s*/gi,
      /<\|.*?\|>/g, // model control tokens (e.g. <|endoftext|>)
    ];

    let sanitized = truncated;
    for (const pattern of injectionPatterns) {
      sanitized = sanitized.replace(pattern, '[removed]');
    }

    return sanitized;
  }

  private checkAI(): void {
    if (!llmAvailable()) {
      throw new Error('No LLM configured — check AZURE_ANTHROPIC_API_KEY / AZURE_OPENAI_API_KEY');
    }
  }
  
  /**
   * Handle text question using Socratic method
   */
  async handleTextQuestion(learner: any, enrollment: any, question: string): Promise<void> {
    const db = await getDb();
    const messaging = await getMessaging();
    
    try {
      this.checkAI();

      // Sanitize learner input before it touches the LLM prompt
      const safeQuestion = this.sanitizeInput(question);

      if (!enrollment) {
        await messaging.sendText(learner.phone, {
          text: "You're not enrolled in any course yet. Type 'courses' to see available courses!"
        });
        return;
      }

      // Get course and lessons for context
      const course = await db.courses.findById(enrollment.course_id);
      const lessons = await db.lessons.findByCourse(enrollment.course_id);

      // ── Context capping: only current + previous lesson (not all completed) ──
      // Avoids sending the entire course history on every Q&A call.
      const currentLesson = enrollment.current_lesson_id
        ? lessons.find((l: any) => l.id === enrollment.current_lesson_id)
        : null;
      const currentOrder: number = currentLesson?.sequence_order ?? 1;
      const contextLessons = lessons.filter(
        (l: any) => l.sequence_order >= currentOrder - 1 && l.sequence_order <= currentOrder
      );
      const contentContext = contextLessons
        .map((l: any) => `Lesson ${l.sequence_order}: ${l.title}\n${l.content}`)
        .join('\n\n');

      // ── Conversation memory: last 10 messages stored in learner.metadata ──
      const memory: Array<{ role: 'user' | 'assistant'; content: string }> =
        learner.metadata?.conversationHistory ?? [];

      // Generate Socratic response using gpt-4o-mini
      const response = await this.generateDirectResponse({
        question: safeQuestion,
        contentContext,
        courseName: course?.title || 'the course',
        language: learner.language || 'en',
        history: memory,
      });

      // Persist updated conversation history (cap at 10 pairs = 20 entries)
      const updatedHistory = [
        ...memory,
        { role: 'user' as const, content: safeQuestion },
        { role: 'assistant' as const, content: response },
      ].slice(-20);
      await db.learners.update(learner.id, {
        metadata: { ...learner.metadata, conversationHistory: updatedHistory },
      });

      // Log the Q&A exchange
      await db.messageLog.create({
        learnerId: learner.id,
        direction: 'outbound',
        messageType: 'qa_response',
        content: response,
        metadata: { question: safeQuestion, courseId: enrollment.course_id }
      });

      await messaging.sendText(learner.phone, { text: response });

      // Offer to continue or end
      await messaging.sendInteractiveButtons(learner.phone, {
        body: 'Would you like to ask more or continue learning?',
        buttons: [
          { id: 'ask_question', title: 'Ask Another' },
          { id: 'next', title: 'Continue Course' }
        ]
      });

    } catch (error: any) {
      logger.error('Q&A error:', error);
      
      await messaging.sendText(learner.phone, {
        text: "Sorry, I couldn't process your question. Let me know if you want to try again!"
      });
    }
  }

  /**
   * Generate a direct answer, optionally followed by one follow-up probe.
   * Uses mini model (cheaper) — context is capped to 2 lessons.
   * Conversation history (up to 10 pairs) is injected for continuity.
   */
  private async generateDirectResponse(params: {
    question: string;
    contentContext: string;
    courseName: string;
    language: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
  }): Promise<string> {
    const { question, contentContext, courseName, language, history } = params;

    const langLabel = language === 'hi' ? 'Hindi' : language === 'ar' ? 'Arabic' : 'English';

    const systemPrompt = `You are Alfred, a helpful tutor for "${courseName}".

Answer the learner's question clearly and directly first, then optionally ask ONE follow-up question to deepen understanding.

Rules:
- Give a clear, direct answer in the first 1-3 sentences — do NOT respond with a question alone
- Use simple language; no jargon
- After the answer, you may add one short follow-up probe (optional, only if it adds value)
- Total response under 150 words — this is WhatsApp
- Be warm and encouraging
- Respond in ${langLabel}

Relevant course content:
${contentContext || 'No lesson content loaded yet.'}`;

    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: question },
    ];

    // Use mini model — adequate for tutoring, cheaper than full model
    const completion = await llmChat({
      messages,
      maxTokens: 300,
      temperature: 0.7,
      model: 'mini',
    });

    return completion.choices[0]?.message?.content ||
      "I'm having trouble responding. Could you rephrase your question?";
  }

  /**
   * Handle voice message (requires transcription)
   */
  async handleVoiceQuestion(learner: any, enrollment: any, mediaId: string): Promise<void> {
    const messaging = await getMessaging();
    
    // Voice transcription disabled - requires Whisper API setup
    await messaging.sendText(learner.phone, {
      text: "Voice messages are not supported yet. Please type your question!"
    });
  }

  /**
   * Handle image question (requires vision)
   */
  async handleImageQuestion(learner: any, enrollment: any, mediaId: string, caption?: string): Promise<void> {
    const messaging = await getMessaging();
    
    // Image analysis disabled - requires Vision API setup  
    await messaging.sendText(learner.phone, {
      text: "Image questions are not supported yet. Please describe your question in text!"
    });
  }

  /**
   * Use RAG to find relevant content
   */
  async searchRelevantContent(courseId: string, query: string): Promise<string[]> {
    const db = await getDb();
    
    try {
      if (!azureOpenAI.isAvailable()) return [];

      // Generate embedding for query using Azure OpenAI
      const embeddingResponse = await azureOpenAI.createEmbedding(query);

      const embedding = embeddingResponse.data[0].embedding;

      // Search with pgvector
      const results = await db.embeddings.search(courseId, embedding, 3);
      
      return results.map((r: any) => r.content);
    } catch (error) {
      logger.error('RAG search error:', error);
      return [];
    }
  }
}
