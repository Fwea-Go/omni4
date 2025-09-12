import plotly.graph_objects as go
import plotly.express as px

# Define component positions and properties
components = {
    'Wix Frontend': {'x': 2, 'y': 5, 'type': 'frontend', 'color': '#1FB8CD'},
    'Cloudflare Workers': {'x': 2, 'y': 4, 'type': 'backend', 'color': '#DB4545'},
    'R2 Storage': {'x': 1, 'y': 3, 'type': 'storage', 'color': '#2E8B57'},
    'KV Store': {'x': 2, 'y': 3, 'type': 'storage', 'color': '#2E8B57'},
    'D1 Database': {'x': 3, 'y': 3, 'type': 'storage', 'color': '#2E8B57'},
    'Cloudflare AI': {'x': 1.5, 'y': 2, 'type': 'processing', 'color': '#5D878F'},
    'RunPod': {'x': 2.5, 'y': 2, 'type': 'processing', 'color': '#5D878F'},
    'Stripe': {'x': 3.5, 'y': 1, 'type': 'payment', 'color': '#D2BA4C'},
    'GitHub': {'x': 0.5, 'y': 4, 'type': 'deployment', 'color': '#B4413C'}
}

# Create the figure
fig = go.Figure()

# Add component boxes as rectangles
for name, props in components.items():
    # Add rectangle shape
    fig.add_shape(
        type="rect",
        x0=props['x']-0.3, y0=props['y']-0.2,
        x1=props['x']+0.3, y1=props['y']+0.2,
        fillcolor=props['color'],
        line=dict(color="white", width=2),
        opacity=0.8
    )
    
    # Add component name as annotation
    fig.add_annotation(
        x=props['x'], y=props['y'],
        text=name.replace(' ', '<br>'),
        showarrow=False,
        font=dict(color="white", size=9),
        align="center"
    )

# Add layer background rectangles
layers = [
    {'name': 'Frontend', 'y': 5, 'color': '#1FB8CD', 'alpha': 0.1},
    {'name': 'Backend', 'y': 4, 'color': '#DB4545', 'alpha': 0.1},
    {'name': 'Storage', 'y': 3, 'color': '#2E8B57', 'alpha': 0.1},
    {'name': 'Processing', 'y': 2, 'color': '#5D878F', 'alpha': 0.1},
    {'name': 'Payment', 'y': 1, 'color': '#D2BA4C', 'alpha': 0.1}
]

for layer in layers:
    fig.add_shape(
        type="rect",
        x0=-0.2, y0=layer['y']-0.4,
        x1=4.2, y1=layer['y']+0.4,
        fillcolor=layer['color'],
        opacity=layer['alpha'],
        line=dict(width=0)
    )

# Add layer labels
for layer in layers:
    fig.add_annotation(
        x=-0.1, y=layer['y'],
        text=layer['name'],
        showarrow=False,
        font=dict(color="gray", size=11),
        textangle=90,
        align="center"
    )

# Add flow arrows - User Flow
user_flow_arrows = [
    # Upload to Workers
    {'start': (2, 4.8), 'end': (2, 4.2), 'color': 'blue'},
    # Workers to Storage
    {'start': (1.8, 3.8), 'end': (1.3, 3.2), 'color': 'blue'},
    {'start': (2, 3.8), 'end': (2, 3.2), 'color': 'blue'},
    {'start': (2.2, 3.8), 'end': (2.7, 3.2), 'color': 'blue'},
    # Workers to Processing
    {'start': (1.8, 3.8), 'end': (1.6, 2.2), 'color': 'blue'},
    {'start': (2.2, 3.8), 'end': (2.4, 2.2), 'color': 'blue'},
    # Workers to Payment
    {'start': (2.5, 3.8), 'end': (3.3, 1.2), 'color': 'blue'}
]

# Add admin bypass arrow
fig.add_annotation(
    x=2.8, y=4.5,
    ax=2.2, ay=4.5,
    xref="x", yref="y",
    axref="x", ayref="y",
    arrowhead=2,
    arrowsize=1,
    arrowwidth=3,
    arrowcolor="red",
    text="Admin Bypass",
    font=dict(color="red", size=8)
)

# Add user flow arrows
for arrow in user_flow_arrows:
    fig.add_annotation(
        x=arrow['end'][0], y=arrow['end'][1],
        ax=arrow['start'][0], ay=arrow['start'][1],
        xref="x", yref="y",
        axref="x", ayref="y",
        arrowhead=2,
        arrowsize=1,
        arrowwidth=2,
        arrowcolor=arrow['color']
    )

# Add external integration arrows
# GitHub to Workers
fig.add_annotation(
    x=1.7, y=4,
    ax=0.8, ay=4,
    xref="x", yref="y",
    axref="x", ayref="y",
    arrowhead=2,
    arrowsize=1,
    arrowwidth=2,
    arrowcolor="green"
)

# Add user journey labels
fig.add_annotation(
    x=4, y=5.5,
    text="User Journey:<br>1. Upload Audio<br>2. AI Analysis<br>3. Preview<br>4. Payment<br>5. Download",
    showarrow=False,
    font=dict(color="blue", size=9),
    align="left",
    bgcolor="rgba(255,255,255,0.8)",
    bordercolor="blue",
    borderwidth=1
)

# Add admin journey labels
fig.add_annotation(
    x=4, y=4.5,
    text="Admin Path:<br>• Token Bypass<br>• Full Access<br>• No Payment",
    showarrow=False,
    font=dict(color="red", size=9),
    align="left",
    bgcolor="rgba(255,255,255,0.8)",
    bordercolor="red",
    borderwidth=1
)

# Update layout
fig.update_layout(
    title='FWEA-I Audio System Architecture',
    xaxis=dict(
        range=[-0.5, 5],
        showgrid=False,
        showticklabels=False,
        zeroline=False
    ),
    yaxis=dict(
        range=[0.5, 6],
        showgrid=False,
        showticklabels=False,
        zeroline=False
    ),
    plot_bgcolor='white',
    showlegend=False
)

# Save the chart
fig.write_image('fwea_architecture_updated.png')