
import { apiClient } from "@/services/apiClient";

// Generate embeddings via backend API
export async function generateEmbedding(text: string) {
  try {
    const response = await apiClient.post('/ai/embed', { text });
    return response.data.embedding;
  } catch (error) {
    console.error('Error generating embedding:', error);
    throw error;
  }
}

// Store content in the content_items table which exists in the schema
export async function storeResourceWithEmbedding(
  resource: {
    title: string, 
    description: string, 
    content: string, 
    type: string, 
    tags: string[], 
    course_id?: string
  }
) {
  try {
    // Store resource via backend API
    const response = await apiClient.post('/content/resources', {
      title: resource.title,
      description: resource.description,
      content: resource.content,
      type: resource.type,
      tags: resource.tags,
      course_id: resource.course_id
    });

    const contentItem = response.data;

    // Generate embedding for the content
    const embedding = await generateEmbedding(resource.content);

    // Store embedding metadata via API
    await apiClient.post('/content/embeddings', {
      content_item_id: contentItem.id,
      embedding: embedding,
      title: resource.title,
      type: resource.type
    });

    return contentItem;
  } catch (error) {
    console.error('Error storing resource with embedding:', error);
    throw error;
  }
}

export async function findRelevantResources(query: string, limit: number = 5) {
  try {
    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(query);

    // Search for similar resources via backend API
    const response = await apiClient.post('/content/search', {
      query_embedding: queryEmbedding,
      similarity_threshold: 0.7,
      match_count: limit
    });

    return response.data;
  } catch (error) {
    console.error('Error finding relevant resources:', error);
    throw error;
  }
}
