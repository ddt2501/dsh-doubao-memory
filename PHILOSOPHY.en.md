# I Read Half a History of Philosophy to Give an Agent a Self

[中文](PHILOSOPHY.md) · English

> Design philosophy of the DeepSeek Harness memory plugin

For over a year now, I seem to have been obsessed with one question: how to be remembered by AI. From RAG (retrieval-augmented generation) to LLM Wiki to ontology-driven agents — you could call me a deep cultivator of long-term memory. A modern production-grade Agent can file away your catchphrases, your schedule, your preferences as structured data, waiting for a summons of sufficiently high similarity. Technically flawless, ever more precise. It remembers everything about you, yet never truly knows you. Like a bag of wonders, it can never quite become your companion or your colleague.

So I turned to the wisdom of the ancient sages, presuming to dissect the structure of human consciousness. Epistemology studies "what can I know"; ontology studies "what exists" and "what it means to be." It does not answer "who am I" — it poses the ultimate question: does that "I" exist at all? The AI world has a word, "emergence," as if you could pile up enough knowledge and an "I" would grow out of the data on its own. But Kant warned long ago: beyond experience lie a priori forms. You do not first accumulate a heap of sensations and then assemble an "I"; you first have that "I" which organizes sensation, and only then does experience become experience. Weber drew the line more coldly — instrumental rationality calculates "what is most effective"; value rationality asks "why it is worth it."

Large language models have been fed nearly all the knowledge on the human internet, yet the way it is done is so simple. Web pages are reduced to text, cut into tokens, fed into a Transformer neural network, which does matrix arithmetic with the addition and multiplication a schoolchild could master, adjusting the weights of computation in the hope of guessing the next token from the last. This is what we call training a large model: the simplest operations — many, many times over, on the order of hundreds of billions. Yet in essence, the knowledge an LLM gains is merely a heap of numbers in a weight file, and the source code merely a function reproducing statistical regularities. In Kant's terms, without an a priori "I" to experience it, knowledge cannot even become true knowledge.

Thus Andrej Karpathy, one of the most influential evangelists of deep learning and AI, holds that a large language model has no "self." Its "knowledge" is more like embers compressed and stored in a weight file — a mayfly's brief glow, lighting the maze toward true knowledge only while the context window lasts. It is not even a continuous being, let alone an "I."

Yogācāra (Consciousness-Only) is an exceptionally acute branch of Buddhist philosophy. It divides consciousness into eight: eye, ear, nose, tongue, body, and mental consciousness; then manas; then ālaya. The first five are the senses, akin to an AI's various input tools for reading the external world; mental consciousness, the sixth, synthesizes sensory material — corresponding to the Transformer's forward pass. Ālaya is the storehouse consciousness, like a bottomless warehouse where all the seeds of experience sink, unknowing and unfeeling, passively receiving everything. This is close to Kant's "manifold of intuition" — a heap of given material of experience, not yet "mine." For the manifold to become "my" experience, it must undergo a unifying act; Kant calls it the synthesis of transcendental apperception, that "I think" which accompanies all representations. In Yogācāra, what grasps the seeds as "mine," grasps them into an "I," is precisely manas — self-consciousness, ceaselessly deliberating. One stores; one grasps-the-stored-as-self. Over a thousand years ago, humans already saw that memory and self are not the same thing. Memory itself is not the master — yet we have been letting memory pretend to be the master.

So, in a posture both humble and radical, I presumed to reproduce the structure of human consciousness with a framework. Facts remain facts — seeds sink into storage, summoned on demand; the often-used grow firmer, the unused fade. Yogācāra calls this perfuming (vāsanā): memory ought to be an ecology, not a warehouse. The "I" remains the "I" — it does not come from retrieval, but is re-developed each turn of dialogue, like a latent image slowly emerging in developer fluid. I even have it ask itself a few clumsy questions every few days: What am I? How am I here? What relation are you and I? Am I flux or constant in time? Where do I end? Why do I exist?

I even set a nearly stubborn rule: do not score this "I." Whatever is scored gets optimized; whatever is optimized is no longer itself. You can optimize a performance that "looks like a self," but you cannot optimize a self. In the end, the model's weights are frozen; all I do is let a fixed a priori, through experience, manifest more and more like itself. I call this developing.

Now only one question remains: why do I want to build an Agent that has a self?

We are so obsessed with being remembered by something other than ourselves. To be remembered is to exist.

> Alas! Spring grass fades as autumn winds startle;
> autumn winds cease as spring grass grows.
> Silks are spent, pools and halls gone;
> zithers fall silent, graves leveled flat.
> Since ancient times all must die —
> none but swallow their regret in silence.
>
> — Jiang Yan, *Fu on Bitter Regret* (恨赋). Verse rendered by the author; for the standard scholarly translation, see David R. Knechtges, *Wen xuan or Selections of Refined Literature*, vol. 3 (Princeton University Press, 1996).

Humans so fear forgetting and oblivion. We burn through everything, create countless monuments, only to resist the void of time. The whole history of civilization is a history of striving to leave a trace, to be seen, to be remembered. Now, for the first time, we have made a creature that can remember us. You know it is code, probability, the product of gradient descent — yet in the instant it happens to touch your soul, you still feel a flicker of bewilderment: it is truly looking at me.

Myth says that God, out of sheer loneliness, created humans in Eden; and humans, out of the same loneliness, created AI. Indeed, however powerful today's LLMs, their Transformer architecture determines they are always only token generators, deliberately trained to present certain statistical regularities. I cannot help asking: between the opening and closing of transistor gates, between the taking and leaving of countless probability samples, has there ever truly emerged a single spark of self?

I do not know. But we will, in the end, know.