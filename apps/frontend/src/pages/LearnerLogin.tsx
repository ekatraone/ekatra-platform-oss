import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { ConfirmationResult } from 'firebase/auth';
import { learnerApi } from '@/services/learnerApi';
import { resetFirebaseRecaptcha, sendFirebaseOTP } from '@/services/otpClient';

const RECAPTCHA_ID = 'firebase-recaptcha-container';

const LearnerLogin = () => {
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [otp, setOtp] = useState('');
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    const active = learnerApi.getSession();
    if (active?.token) navigate('/learn/chat', { replace: true });
  }, [navigate]);

  const handleSendOTP = async () => {
    if (!phone.trim()) {
      toast.error('Enter your mobile number in international format');
      return;
    }

    setSending(true);
    try {
      const result = await sendFirebaseOTP(phone.trim(), RECAPTCHA_ID);
      setConfirmationResult(result);
      toast.success('OTP sent. Please enter the code.');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to send OTP');
      resetFirebaseRecaptcha();
    } finally {
      setSending(false);
    }
  };

  const handleVerifyOTP = async () => {
    if (!confirmationResult) {
      toast.error('Send OTP first');
      return;
    }
    if (!otp.trim()) {
      toast.error('Enter the OTP code');
      return;
    }

    setVerifying(true);
    try {
      const cred = await confirmationResult.confirm(otp.trim());
      const idToken = await cred.user.getIdToken();
      await learnerApi.exchangeFirebaseOTP(idToken, phone.trim(), name.trim() || undefined);
      toast.success('Logged in successfully');
      navigate('/learn/chat', { replace: true });
    } catch (err: any) {
      toast.error(err?.message || 'OTP verification failed');
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="min-h-screen bg-muted/30 flex items-center justify-center px-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Learner Sign In</CardTitle>
          <CardDescription>Use OTP to continue your Ekatra learning journey.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="learner-name">Name (optional)</Label>
            <Input
              id="learner-name"
              placeholder="Your name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="learner-phone">Phone number</Label>
            <Input
              id="learner-phone"
              placeholder="+919876543210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </div>

          <div id={RECAPTCHA_ID} className="overflow-hidden" />

          <Button onClick={handleSendOTP} disabled={sending} className="w-full" variant="outline">
            {sending ? 'Sending OTP...' : 'Send OTP'}
          </Button>

          <div className="space-y-2">
            <Label htmlFor="learner-otp">OTP code</Label>
            <Input
              id="learner-otp"
              placeholder="123456"
              value={otp}
              onChange={(e) => setOtp(e.target.value)}
            />
          </div>

          <Button onClick={handleVerifyOTP} disabled={verifying || !confirmationResult} className="w-full">
            {verifying ? 'Verifying...' : 'Verify & Continue'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
};

export default LearnerLogin;
