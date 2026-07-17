
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
import Login from "./pages/Login";
import LearnerLogin from "./pages/LearnerLogin";
import LearnerChat from "./pages/LearnerChat";
import Dashboard from "./pages/Dashboard";
import Courses from "./pages/Courses";
import CourseEditor from "./pages/CourseEditor";
import CoursePreview from "./pages/CoursePreview";
import Users from "./pages/Users";
import Learners from "./pages/Learners";
import WhatsApp from "./pages/WhatsApp";
import Telegram from "./pages/Telegram";
import ChatHistory from "./pages/ChatHistory";
import Analytics from "./pages/Analytics";
import Settings from "./pages/Settings";
import Schedules from "./pages/Schedules";
import FSMEditor from "./pages/FSMEditor";
import NotFound from "./pages/NotFound";
import { ROUTES } from "./lib/constants";
import { AuthProvider, RequireAuth } from "./components/AuthProvider";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <BrowserRouter>
        <AuthProvider>
          <Toaster />
          <Sonner />
          <Routes>
            <Route path={ROUTES.HOME} element={<Index />} />
            <Route path={ROUTES.LOGIN} element={<Login />} />
            <Route path={ROUTES.LEARNER_LOGIN} element={<LearnerLogin />} />
            <Route path={ROUTES.LEARNER_CHAT} element={<LearnerChat />} />
            <Route path={ROUTES.DASHBOARD} element={
              <RequireAuth>
                <Dashboard />
              </RequireAuth>
            } />
            <Route path={ROUTES.COURSES} element={
              <RequireAuth>
                <Courses />
              </RequireAuth>
            } />
            <Route path={`${ROUTES.COURSES}/editor`} element={
              <RequireAuth>
                <CourseEditor />
              </RequireAuth>
            } />
            <Route path={`${ROUTES.COURSES}/editor/:id`} element={
              <RequireAuth>
                <CourseEditor />
              </RequireAuth>
            } />
            <Route path={`${ROUTES.COURSES}/preview/:id`} element={
              <RequireAuth>
                <CoursePreview />
              </RequireAuth>
            } />
            <Route path={ROUTES.USERS} element={
              <RequireAuth>
                <Users />
              </RequireAuth>
            } />
            <Route path={ROUTES.LEARNERS} element={
              <RequireAuth>
                <Learners />
              </RequireAuth>
            } />
            <Route path={ROUTES.WHATSAPP} element={
              <RequireAuth>
                <WhatsApp />
              </RequireAuth>
            } />
            <Route path="/telegram" element={
              <RequireAuth>
                <Telegram />
              </RequireAuth>
            } />
            <Route path="/chat-history" element={
              <RequireAuth>
                <ChatHistory />
              </RequireAuth>
            } />
            <Route path="/schedules" element={
              <RequireAuth>
                <Schedules />
              </RequireAuth>
            } />
            <Route path={ROUTES.ANALYTICS} element={
              <RequireAuth>
                <Analytics />
              </RequireAuth>
            } />
            <Route path={ROUTES.SETTINGS} element={
              <RequireAuth>
                <Settings />
              </RequireAuth>
            } />
            <Route path={ROUTES.FSM_EDITOR} element={
              <RequireAuth>
                <FSMEditor />
              </RequireAuth>
            } />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
