# WhatsApp Cloud API Setup Guide

This guide will help you set up WhatsApp Cloud API integration for Ekatra Platform using Meta Business APIs.

## Prerequisites

✅ You are already logged in to Azure CLI:
- Account: `a_ekatra@5lzvp5.onmicrosoft.com`
- Subscription: `ekatra_Microsoft Azure`
- Azure OpenAI is already configured in `.env`

## Step 1: Create a Meta Business Account

1. Go to [Meta Business Suite](https://business.facebook.com/)
2. Create a new business account or use existing
3. Verify your business (required for production use)

## Step 2: Create a WhatsApp Business App

1. Go to [Meta for Developers](https://developers.facebook.com/)
2. Click **"My Apps"** → **"Create App"**
3. Choose **"Business"** as app type
4. Fill in app details:
   - **App Name**: Ekatra WhatsApp Bot
   - **App Contact Email**: your-email@domain.com
   - **Business Account**: Select your business

5. Click **"Create App"**

## Step 3: Add WhatsApp Product

1. In your app dashboard, find **"WhatsApp"** product
2. Click **"Set Up"** or **"Add to App"**
3. Select or create a **WhatsApp Business Account**

## Step 4: Get Phone Number

### For Testing (Free):
1. Go to **WhatsApp** → **Getting Started**
2. Use the **Test Phone Number** provided by Meta
3. Add your personal WhatsApp number as a test recipient
4. Send a test message to verify

### For Production:
1. Go to **WhatsApp** → **Phone Numbers**
2. Click **"Add Phone Number"**
3. Follow verification process (SMS or voice call)
4. Complete business verification if not already done

## Step 5: Get Your Credentials

### 1. Temporary Access Token (Testing - 24 hours)

Go to **WhatsApp** → **API Setup**:

```
META_ACCESS_TOKEN=EAAxxxxxxx (copy from dashboard)
META_PHONE_NUMBER_ID=123456789012345 (shown above the token)
```

### 2. Permanent Access Token (Production)

For production, you need a **System User Token**:

1. Go to [Business Settings](https://business.facebook.com/settings/)
2. **Users** → **System Users** → **Add**
3. Create a system user (e.g., "Ekatra Bot")
4. Click **"Add Assets"**
5. Add your **WhatsApp Business Account** with **Full Control**
6. Click **"Generate New Token"**
7. Select:
   - **App**: Your WhatsApp app
   - **Permissions**: `whatsapp_business_messaging`, `whatsapp_business_management`
   - **Token Expiration**: Never expire (60 days or custom)
8. Copy the generated token → **This is your permanent `META_ACCESS_TOKEN`**

### 3. Business Account ID

Go to **WhatsApp** → **Getting Started**:
```
META_BUSINESS_ACCOUNT_ID=987654321098765 (shown in dashboard)
```

### 4. App Secret

Go to **Settings** → **Basic**:
```
META_APP_SECRET=your_app_secret_here (click "Show")
```

### 5. Webhook Verification Token

Create your own random string (use for webhook verification):
```
META_WEBHOOK_VERIFY_TOKEN=your_random_secure_string_12345
```

## Step 6: Configure Webhooks

### Local Development (using ngrok):

```bash
# Install ngrok
brew install ngrok

# Start your backend server
cd /Users/Shared/Scripts/ekatra-master/ekatra-platform
pnpm --filter @ekatra/backend dev

# In another terminal, expose your local server
ngrok http 3001
```

Copy the ngrok URL (e.g., `https://abc123.ngrok.io`)

### Configure in Meta Dashboard:

1. Go to **WhatsApp** → **Configuration**
2. In **Webhook** section, click **"Edit"**
3. Enter:
   - **Callback URL**: `https://abc123.ngrok.io/api/webhook/whatsapp`
   - **Verify Token**: Your `META_WEBHOOK_VERIFY_TOKEN` (from .env)
4. Click **"Verify and Save"**

5. Subscribe to webhook fields:
   - ✅ `messages`
   - ✅ `message_template_status_update`

## Step 7: Update Your .env File

```bash
cd /Users/Shared/Scripts/ekatra-master/ekatra-platform
nano .env
```

Update these values:

```env
# WhatsApp Cloud API
META_ACCESS_TOKEN=YOUR_ACTUAL_TOKEN_HERE
META_PHONE_NUMBER_ID=YOUR_ACTUAL_PHONE_NUMBER_ID
META_BUSINESS_ACCOUNT_ID=YOUR_BUSINESS_ACCOUNT_ID
META_WEBHOOK_VERIFY_TOKEN=your_random_secure_string_12345
META_APP_SECRET=your_app_secret_here

# Already configured (from working setup):
AZURE_OPENAI_ENDPOINT=https://aeka-mf7uw5hr-swedencentral.cognitiveservices.azure.com
AZURE_OPENAI_API_KEY=your_azure_openai_key_here
AZURE_OPENAI_API_VERSION=2025-01-01-preview
AZURE_OPENAI_DEPLOYMENT=gpt-4o
AZURE_OPENAI_ASSISTANT_ID=your_assistant_id
AZURE_OPENAI_VECTOR_STORE_ID=your_vector_store_id
```

## Step 8: Test the Integration

### 1. Restart Backend:

```bash
cd /Users/Shared/Scripts/ekatra-master/ekatra-platform
pnpm --filter @ekatra/backend dev
```

### 2. Verify Webhook:

Check your terminal for:
```
✅ WhatsApp webhook verified
✅ Azure OpenAI initialized
🚀 Ekatra Backend Started
```

### 3. Send Test Message:

From WhatsApp, send a message to your test number:
```
Hello
```

You should see webhook events in your terminal logs.

### 4. Test from Dashboard:

Go to **WhatsApp** → **API Setup** → **Send Test Message**
- Enter your phone number
- Click "Send Message"
- You should receive it on WhatsApp

## Step 9: Deploy to Production

For production deployment, you need:

1. **Domain with HTTPS**: Get SSL certificate
2. **Public webhook URL**: Deploy to Azure/Vercel/Render
3. **Update webhook**: Point to your production URL
4. **Use permanent token**: From System User (Step 5.2)

### Azure Deployment Option:

```bash
# We can deploy to Azure App Service
az webapp create \
  --resource-group ekatra-resources \
  --plan ekatra-plan \
  --name ekatra-backend \
  --runtime "NODE|20-lts"

az webapp config appsettings set \
  --resource-group ekatra-resources \
  --name ekatra-backend \
  --settings META_ACCESS_TOKEN="your_token" \
          META_PHONE_NUMBER_ID="your_id" \
          # ... other env vars
```

## Testing Checklist

- [ ] Temporary access token obtained
- [ ] Test phone number added
- [ ] Webhook URL configured with ngrok
- [ ] Webhook verification successful
- [ ] `.env` file updated with all credentials
- [ ] Backend server started successfully
- [ ] Azure OpenAI initialized
- [ ] Test message sent from dashboard
- [ ] Test message received on WhatsApp
- [ ] Webhook events appearing in logs
- [ ] Q&A responses working with Azure OpenAI

## Troubleshooting

### Webhook verification fails:
- Check `META_WEBHOOK_VERIFY_TOKEN` matches in .env and Meta dashboard
- Ensure ngrok is running and URL is correct
- Check backend logs for errors

### No messages received:
- Verify webhook subscribed to `messages` field
- Check if using test number and added recipient
- Look for errors in Meta dashboard → WhatsApp → Webhooks

### Azure OpenAI errors:
- Verify API key and endpoint in .env
- Check deployment name matches your Azure resource
- Ensure API version is correct (2025-01-01-preview)

### Access token expired:
- Temporary tokens last 24 hours
- Generate permanent token using System User (Step 5.2)

## API Reference

- [WhatsApp Cloud API Docs](https://developers.facebook.com/docs/whatsapp/cloud-api/)
- [Webhook Setup Guide](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/set-up-webhooks)
- [Message Templates](https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates)
- [Azure OpenAI Service](https://learn.microsoft.com/azure/ai-services/openai/)

## Need Help?

Your Azure account is already configured:
- Subscription: `ekatra_Microsoft Azure`
- Account: `a_ekatra@5lzvp5.onmicrosoft.com`
- Azure OpenAI: Already set up and tested

The working configuration from `azure-whatsapp-old` has been integrated into this project.
