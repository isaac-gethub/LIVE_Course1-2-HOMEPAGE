const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Stripe requires the raw, unparsed request body to verify the webhook signature.
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

function buffer(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end('Method not allowed');
  }

  let event;
  try {
    const rawBody = await buffer(req);
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const metadata = session.metadata || {};
    const email = session.customer_details?.email || session.customer_email;

    try {
      const { error: insertError } = await supabaseAdmin
        .from('course_enrollments')
        .insert({
          stripe_session_id: session.id,
          stripe_customer_id: session.customer,
          stripe_payment_intent: session.payment_intent,
          full_name: metadata.full_name || null,
          email,
          phone: metadata.phone || null,
          country: metadata.country || null,
          track: metadata.track || null,
          course: metadata.course || 'full_sweep',
          amount_total: session.amount_total,
          currency: session.currency,
          status: 'paid',
        });

      // 23505 = unique_violation on stripe_session_id — Stripe re-sent an event we already processed.
      if (insertError && insertError.code !== '23505') {
        console.error('Supabase insert error:', insertError);
      }

      const { error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
        redirectTo: process.env.COURSE_ACCESS_GATEWAY_URL,
        data: {
          full_name: metadata.full_name || null,
          track: metadata.track || null,
          course: metadata.course || 'full_sweep',
        },
      });

      if (inviteError && !String(inviteError.message).toLowerCase().includes('already registered')) {
        console.error('Supabase invite error:', inviteError);
      } else {
        await supabaseAdmin
          .from('course_enrollments')
          .update({ account_created: true })
          .eq('stripe_session_id', session.id);
      }
    } catch (err) {
      // Payment already succeeded on Stripe's side. Log and return 200 so Stripe
      // doesn't keep retrying — a missed insert/invite can be replayed manually
      // from the Stripe dashboard event log if needed.
      console.error('Post-payment processing error:', err);
    }
  }

  return res.status(200).json({ received: true });
};
