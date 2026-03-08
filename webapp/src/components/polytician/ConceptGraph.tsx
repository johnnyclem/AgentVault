'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

interface GraphNode {
  id: string
  name: string
  type?: string
  x: number
  y: number
  vx: number
  vy: number
}

interface GraphEdge {
  source: string
  target: string
  label?: string
}

interface ConceptGraphProps {
  agentId: string
  conceptId?: string
  width?: number
  height?: number
}

export function ConceptGraph({
  agentId,
  conceptId,
  width = 600,
  height = 400,
}: ConceptGraphProps) {
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const animationRef = useRef<number>()

  const fetchGraphData = useCallback(async () => {
    if (!conceptId) return

    setLoading(true)

    try {
      const res = await fetch(
        `/api/polytician/${agentId}/concepts/${conceptId}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.NEXT_PUBLIC_API_TOKEN || ''}`,
          },
        }
      )

      if (!res.ok) throw new Error('Failed to fetch concept')

      const data = await res.json()
      if (data.success && data.data) {
        const concept = data.data
        const nodePositions = generateNodePositions(concept)
        setNodes(nodePositions.nodes)
        setEdges(nodePositions.edges)
      }
    } catch (error) {
      console.error('Failed to fetch graph data:', error)
    } finally {
      setLoading(false)
    }
  }, [agentId, conceptId])

  useEffect(() => {
    fetchGraphData()
  }, [fetchGraphData])

  useEffect(() => {
    if (nodes.length === 0) return

    const simulate = () => {
      setNodes((prevNodes) => {
        const newNodes = prevNodes.map((node) => {
          let fx = 0
          let fy = 0

          // Repulsion from other nodes
          prevNodes.forEach((other) => {
            if (other.id === node.id) return
            const dx = node.x - other.x
            const dy = node.y - other.y
            const dist = Math.sqrt(dx * dx + dy * dy) || 1
            const force = 1000 / (dist * dist)
            fx += (dx / dist) * force
            fy += (dy / dist) * force
          })

          // Attraction to center
          const cx = width / 2 - node.x
          const cy = height / 2 - node.y
          fx += cx * 0.01
          fy += cy * 0.01

          // Edge attraction
          edges.forEach((edge) => {
            if (edge.source === node.id || edge.target === node.id) {
              const otherId = edge.source === node.id ? edge.target : edge.source
              const other = prevNodes.find((n) => n.id === otherId)
              if (other) {
                const dx = other.x - node.x
                const dy = other.y - node.y
                fx += dx * 0.05
                fy += dy * 0.05
              }
            }
          })

          const vx = (node.vx + fx) * 0.5
          const vy = (node.vy + fy) * 0.5

          let x = node.x + vx
          let y = node.y + vy

          // Bounds
          const padding = 40
          x = Math.max(padding, Math.min(width - padding, x))
          y = Math.max(padding, Math.min(height - padding, y))

          return { ...node, vx, vy, x, y }
        })

        return newNodes
      })

      animationRef.current = requestAnimationFrame(simulate)
    }

    animationRef.current = requestAnimationFrame(simulate)

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current)
      }
    }
  }, [nodes.length, edges, width, height])

  const nodeColors: Record<string, string> = {
    concept: '#3B82F6',
    entity: '#10B981',
    relation: '#F59E0B',
    default: '#6B7280',
  }

  if (!conceptId) {
    return (
      <div
        className="flex items-center justify-center bg-gray-50 border border-gray-200 rounded-lg"
        style={{ width, height }}
      >
        <p className="text-gray-500 text-sm">Select a concept to view its graph</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div
        className="flex items-center justify-center bg-gray-50 border border-gray-200 rounded-lg animate-pulse"
        style={{ width, height }}
      >
        <p className="text-gray-400">Loading graph...</p>
      </div>
    )
  }

  if (nodes.length === 0) {
    return (
      <div
        className="flex items-center justify-center bg-gray-50 border border-gray-200 rounded-lg"
        style={{ width, height }}
      >
        <p className="text-gray-500 text-sm">No graph data available</p>
      </div>
    )
  }

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        width={width}
        height={height}
        className="border border-gray-200 rounded-lg bg-white"
      >
        {/* Edges */}
        <g className="edges">
          {edges.map((edge, i) => {
            const source = nodes.find((n) => n.id === edge.source)
            const target = nodes.find((n) => n.id === edge.target)
            if (!source || !target) return null

            return (
              <g key={i}>
                <line
                  x1={source.x}
                  y1={source.y}
                  x2={target.x}
                  y2={target.y}
                  stroke="#CBD5E1"
                  strokeWidth={2}
                />
                {edge.label && (
                  <text
                    x={(source.x + target.x) / 2}
                    y={(source.y + target.y) / 2}
                    textAnchor="middle"
                    className="text-xs fill-gray-400"
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            )
          })}
        </g>

        {/* Nodes */}
        <g className="nodes">
          {nodes.map((node) => (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              onClick={() => setSelectedNode(node)}
              className="cursor-pointer"
            >
              <circle
                r={20}
                fill={nodeColors[node.type || 'default'] || nodeColors.default}
                stroke={selectedNode?.id === node.id ? '#1F2937' : 'none'}
                strokeWidth={3}
                className="transition-all hover:opacity-80"
              />
              <text
                y={32}
                textAnchor="middle"
                className="text-xs fill-gray-700 font-medium"
              >
                {node.name.slice(0, 15)}
                {node.name.length > 15 ? '...' : ''}
              </text>
            </g>
          ))}
        </g>
      </svg>

      {selectedNode && (
        <div className="absolute top-2 right-2 p-3 bg-white border border-gray-200 rounded-lg shadow-sm">
          <div className="text-sm font-medium text-gray-900">{selectedNode.name}</div>
          <div className="text-xs text-gray-500 mt-1">ID: {selectedNode.id}</div>
          <div className="text-xs text-gray-500">Type: {selectedNode.type || 'unknown'}</div>
        </div>
      )}
    </div>
  )
}

function generateNodePositions(concept: Record<string, unknown>): {
  nodes: GraphNode[]
  edges: GraphEdge[]
} {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  // Main concept node
  nodes.push({
    id: concept.id as string,
    name: (concept.name as string) || 'Concept',
    type: 'concept',
    x: 300 + (Math.random() - 0.5) * 100,
    y: 200 + (Math.random() - 0.5) * 100,
    vx: 0,
    vy: 0,
  })

  // Extract entities from content if available
  const content = (concept.content as string) || ''
  const words = content.split(/\s+/).filter((w) => w.length > 4)
  const entities = [...new Set(words.slice(0, 5))]

  entities.forEach((entity, i) => {
    const angle = (2 * Math.PI * i) / entities.length
    const radius = 120
    const id = `entity-${i}`

    nodes.push({
      id,
      name: entity,
      type: 'entity',
      x: 300 + Math.cos(angle) * radius + (Math.random() - 0.5) * 50,
      y: 200 + Math.sin(angle) * radius + (Math.random() - 0.5) * 50,
      vx: 0,
      vy: 0,
    })

    edges.push({
      source: concept.id as string,
      target: id,
      label: 'has',
    })
  })

  return { nodes, edges }
}
