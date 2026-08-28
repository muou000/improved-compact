import { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  createMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { describe, expect, it } from 'vitest'
import { resolveAdaptiveConfig } from '../src/config.ts'
import { SemanticToolResultPruner } from '../src/pruner.ts'

function toolSession(name: string, text: string): Session {
  const callId = CallId('protected-tool-call')
  const session = Session.create(SessionId(`pruner-${name}`))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'run the tool' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name, arguments: '{}' }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

describe('semantic tool-result pruning', () => {
  it('keeps a configured protected tool result byte-for-byte', () => {
    const ctx = new Context()
    void new TokenMeter(ctx)
    const config = resolveAdaptiveConfig({
      toolResult: {
        thresholdChars: 128,
        headChars: 32,
        tailChars: 16,
        signalChars: 32,
        protectedToolNames: ['request_user_input'],
      },
    }).toolResult
    const session = toolSession('request_user_input', 'X'.repeat(500))
    const surfaceBefore = [...session.surface.nodes]

    const result = new SemanticToolResultPruner(ctx, config).pruneSession(session)

    expect(result).toEqual({ pruned: [], charsRemoved: 0 })
    expect(session.surface.nodes).toEqual(surfaceBefore)
    expect(session.events.some(event => event.type === 'compaction/prune')).toBe(false)
  })

  it('lands an adjacent shadow-price event and replay-equivalent replacement', () => {
    const ctx = new Context()
    void new TokenMeter(ctx)
    const config = resolveAdaptiveConfig({
      toolResult: {
        thresholdChars: 256,
        headChars: 64,
        tailChars: 32,
        signalChars: 96,
        protectedToolNames: [],
      },
    }).toolResult
    const session = toolSession(
      'read_artifact',
      `H${'x'.repeat(300)}\nFact: hidden_nonce=blue-lantern-731\n${'y'.repeat(300)}T`,
    )

    const result = new SemanticToolResultPruner(ctx, config).pruneSession(session)
    const replay = Session.create(SessionId('pruner-replay'), [...session.events])
    const visible = session.deriveMessages().flatMap(message => message.content)
      .flatMap(block => block.type === 'tool-result' ? block.content : [block])
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')

    expect(result.pruned).toHaveLength(1)
    expect(visible).toContain('hidden_nonce=blue-lantern-731')
    expect(session.events.at(-2)?.type).toBe('compaction/prune')
    expect(session.events.at(-1)?.type).toBe('tool/result')
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
    expect(new SemanticToolResultPruner(ctx, config).pruneSession(session).pruned).toHaveLength(0)
  })
})
