const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const VALID_TRACKS = new Set(['weekday_950', 'weekend_950']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { full_name, email, phone, country, tier } = req.body || {};

    if (!full_name || !email) {
      return res.status(400).json({ error: 'Full name and email are required.' });
    }

    const track = VALID_TRACKS.has(tier) ? tier : 'weekday_950';
    const trackLabel = track === 'weekend_950' ? 'Weekend Track (Sat/Sun)' : 'Weekday Track (Mon/Wed/Fri)';
    const origin = req.headers.origin || `https://${req.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      submit_type: 'book',
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID_FULL_SWEEP,
          quantity: 1,
        },
      ],
      payment_intent_data: {
        description: `The Full Sweep enrollment — ${trackLabel} — ${full_name}`,
      },
      consent_collection: {
        terms_of_service: 'required',
      },
      custom_text: {
        submit: {
          message: `You're enrolling ${full_name} in The Full Sweep, ${trackLabel}. Your seat is confirmed as soon as payment completes, and we'll email a Course Access setup link to ${email} within a few minutes.`,
        },
        after_submit: {
          message: 'Payment received — redirecting you back to TIB Systems to confirm your seat.',
        },
        terms_of_service_acceptance: {
          message: `I agree to TIB Systems' [Enrollment Terms](${origin}/terms.html), including the cancellation and refund policy.`,
        },
      },
      metadata: {
        course: 'full_sweep',
        track,
        full_name,
        phone: phone || '',
        country: country || '',
      },
      success_url: `${origin}/?paid=1&track=${track}`,
      cancel_url: `${origin}/?canceled=1#pricing`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err);
    return res.status(500).json({
      error: 'Could not start checkout. Please try again or email academy@tib-systems.com.',
    });
  }
};
