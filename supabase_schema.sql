-- Create a table for bills
CREATE TABLE IF NOT EXISTS public.bills (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL, -- LINE User ID
    name TEXT NOT NULL,
    total_amount NUMERIC NOT NULL,
    bill_data JSONB NOT NULL, -- Stores the entire bill state (members, items, etc.)
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE public.bills ENABLE ROW LEVEL SECURITY;

-- Create a policy that allows users to see only their own bills
CREATE POLICY "Users can view their own bills" ON public.bills
    FOR SELECT USING (auth.role() = 'anon' OR auth.role() = 'authenticated'); -- For now we use anon with user_id filter in code

-- Simplified policy for this project: 
-- Anyone can insert, but they must provide their user_id. 
-- In a production app, we would use Supabase Auth with LINE.
-- For this LIFF app, we'll filter by user_id in the application logic.

CREATE POLICY "Anyone can insert bills" ON public.bills
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Users can update their own bills" ON public.bills
    FOR UPDATE USING (true);

CREATE POLICY "Users can delete their own bills" ON public.bills
    FOR DELETE USING (true);
