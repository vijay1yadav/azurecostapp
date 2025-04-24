const express = require('express');
const axios = require('axios');
const cors = require('cors'); // Add CORS package
require('dotenv').config();

const app = express();
//const port = 3000;

// Enable CORS for requests from http://127.0.0.1:5500
app.use(cors({
    origin: '*', // Allow requests from this origin
    methods: ['GET', 'POST'], // Allow these HTTP methods
    allowedHeaders: ['Content-Type'], // Allow these headers
}));

// Middleware to parse JSON bodies
app.use(express.json());

// Azure credentials from environment variables
const tenantId = process.env.TENANT_ID;
const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;

// Validate environment variables
if (!tenantId || !clientId || !clientSecret) {
    console.error('Missing required environment variables: TENANT_ID, CLIENT_ID, or CLIENT_SECRET');
    process.exit(1);
}

// Get access token
const getAccessToken = async () => {
    try {
        const response = await axios.post(
            `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
            new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: clientId,
                client_secret: clientSecret,
                scope: 'https://management.azure.com/.default',
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }
        );
        console.log('Access token fetched successfully');
        return response.data.access_token;
    } catch (error) {
        console.error('Error fetching access token:', error.response?.data || error.message);
        throw new Error('Failed to fetch access token');
    }
};

// Fetch subscriptions
const getSubscriptions = async (accessToken) => {
    try {
        const response = await axios.get(
            'https://management.azure.com/subscriptions?api-version=2020-01-01',
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );
        const subscriptions = response.data.value.map(sub => ({
            subscriptionId: sub.subscriptionId,
            displayName: sub.displayName,
        }));
        console.log('Fetched subscriptions:', subscriptions);
        return subscriptions;
    } catch (error) {
        console.error('Error fetching subscriptions:', error.response?.data || error.message);
        throw new Error('Failed to fetch subscriptions');
    }
};

// Fetch cost data for a subscription
const fetchCostData = async (accessToken, subscriptionId, startDate, endDate) => {
    try {
        const response = await axios.post(
            `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2021-10-01`,
            {
                type: 'Usage',
                timeframe: 'Custom',
                timePeriod: {
                    from: startDate,
                    to: endDate,
                },
                dataset: {
                    granularity: 'None',
                    aggregation: {
                        totalCost: {
                            name: 'Cost',
                            function: 'Sum',
                        },
                    },
                    grouping: [
                        { type: 'Dimension', name: 'MeterCategory' },
                        { type: 'Dimension', name: 'MeterSubCategory' },
                        { type: 'Dimension', name: 'SubscriptionId' },
                        { type: 'Dimension', name: 'ResourceGroup' },
                    ],
                    filter: {
                        dimensions: {
                            name: 'MeterCategory',
                            operator: 'In',
                            values: ['Microsoft Defender for Cloud'],
                        },
                    },
                },
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        console.log(`Cost data response for ${subscriptionId}: Status ${response.status}`);
        console.log('Full response:', JSON.stringify(response.data, null, 2));
        console.log('Rows:', response.data.properties?.rows?.length || 0);
        return response.data;
    } catch (error) {
        console.error(`Error fetching cost data for ${subscriptionId}:`, error.response?.data || error.message);
        throw new Error(`Failed to fetch cost data for ${subscriptionId}`);
    }
};

// API endpoint for costs
app.post('/api/costs', async (req, res) => {
    try {
        const { startDate, endDate } = req.body;
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        console.log(`Received request: startDate=${startDate}, endDate=${endDate}`);
        const accessToken = await getAccessToken();
        const subscriptions = await getSubscriptions(accessToken);

        const costPromises = subscriptions.map(sub =>
            fetchCostData(accessToken, sub.subscriptionId, startDate, endDate)
                .then(data => ({ subscription: sub, data }))
                .catch(error => ({ subscription: sub, error }))
        );

        const results = await Promise.all(costPromises);
        const aggregatedRows = [];
        results.forEach(result => {
            if (result.error) {
                console.error(`Error for subscription ${result.subscription.subscriptionId}:`, result.error.message);
                return;
            }
            const subscriptionId = result.subscription.subscriptionId;
            const subscriptionName = result.subscription.displayName;
            const rows = result.data?.properties?.rows || [];
            rows.forEach(row => {
                const [cost, meterCategory, meterSubCategory, , resourceGroup] = row;
                aggregatedRows.push([
                    cost,
                    meterCategory,
                    meterSubCategory,
                    subscriptionId,
                    resourceGroup || 'Unknown',
                    subscriptionName,
                ]);
            });
        });

        console.log('Aggregated data rows:', aggregatedRows);
        if (aggregatedRows.length === 0) {
            console.log('No cost data found for any subscription');
        }

        res.json({
            properties: {
                rows: aggregatedRows,
                columns: [
                    { name: 'Cost', type: 'Number' },
                    { name: 'MeterCategory', type: 'String' },
                    { name: 'MeterSubCategory', type: 'String' },
                    { name: 'SubscriptionId', type: 'String' },
                    { name: 'ResourceGroup', type: 'String' },
                    { name: 'SubscriptionName', type: 'String' },
                ],
            },
            subscriptions,
        });
    } catch (error) {
        console.error('Error in /api/costs:', error.message);
        res.status(500).json({ error: 'Failed to fetch cost data' });
    }
});

// Fetch top resources for a subscription
const fetchTopResources = async (accessToken, subscriptionId, startDate, endDate) => {
    try {
        const response = await axios.post(
            `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2021-10-01`,
            {
                type: 'Usage',
                timeframe: 'Custom',
                timePeriod: {
                    from: startDate,
                    to: endDate,
                },
                dataset: {
                    granularity: 'None',
                    aggregation: {
                        totalCost: {
                            name: 'Cost',
                            function: 'Sum',
                        },
                    },
                    grouping: [
                        { type: 'Dimension', name: 'ResourceId' },
                        { type: 'Dimension', name: 'MeterSubCategory' },
                    ],
                    filter: {
                        dimensions: {
                            name: 'MeterCategory',
                            operator: 'In',
                            values: ['Microsoft Defender for Cloud'],
                        },
                    },
                },
            },
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        console.log(`Top resources response for ${subscriptionId}: Status ${response.status}`);
        console.log('Full response:', JSON.stringify(response.data, null, 2));
        console.log('Rows:', response.data.properties?.rows?.length || 0);
        return response.data;
    } catch (error) {
        console.error(`Error fetching top resources for ${subscriptionId}:`, error.response?.data || error.message);
        throw new Error(`Failed to fetch top resources for ${subscriptionId}`);
    }
};

// API endpoint for top resources
app.post('/api/top-resources', async (req, res) => {
    try {
        const { startDate, endDate } = req.body;
        if (!startDate || !endDate) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }

        const accessToken = await getAccessToken();
        const subscriptions = await getSubscriptions(accessToken);

        const resourcePromises = subscriptions.map(sub =>
            fetchTopResources(accessToken, sub.subscriptionId, startDate, endDate)
                .then(data => ({ subscription: sub, data }))
        );

        const results = await Promise.all(resourcePromises);

        const topResources = [];
        results.forEach(result => {
            if (result.data?.properties?.rows) {
                result.data.properties.rows.forEach(row => {
                    const cost = row[0];
                    const resourceId = row[1];
                    const meterSubCategory = row[2];
                    const resourceName = resourceId ? resourceId.split('/').pop() : 'Unknown';
                    topResources.push({
                        subscriptionId: result.subscription.subscriptionId,
                        subscriptionName: result.subscription.displayName,
                        resourceName,
                        resourceId,
                        meterSubCategory,
                        cost: parseFloat(cost.toFixed(2)),
                    });
                });
            }
        });

        const sortedResources = topResources.sort((a, b) => b.cost - a.cost).slice(0, 10);
        console.log('Top resources:', sortedResources);

        res.json(sortedResources);
    } catch (error) {
        console.error('Error in /api/top-resources:', error.message);
        res.status(500).json({ error: 'Failed to fetch top resources' });
    }
});

// Fetch Defender plans for a subscription
const fetchDefenderPlans = async (accessToken, subscriptionId) => {
    try {
        const response = await axios.get(
            `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Security/pricings?api-version=2023-01-01`,
            {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            }
        );
        console.log(`Defender plans response for ${subscriptionId}:`, response.data.value.length, 'plans found');
        return response.data;
    } catch (error) {
        console.error(`Error fetching Defender plans for ${subscriptionId}:`, error.response?.data || error.message);
        return null;
    }
};

// API endpoint for Defender plans
app.get('/api/plans', async (req, res) => {
    try {
        const accessToken = await getAccessToken();
        const subscriptions = await getSubscriptions(accessToken);

        const planPromises = subscriptions.map(sub =>
            fetchDefenderPlans(accessToken, sub.subscriptionId)
                .then(data => ({ subscription: sub, data }))
        );

        const results = await Promise.all(planPromises);

        const plansData = [];
        results.forEach(result => {
            if (result.data?.value) {
                result.data.value.forEach(plan => {
                    if (plan.properties?.pricingTier) {
                        plansData.push({
                            subscriptionId: result.subscription.subscriptionId,
                            subscriptionName: result.subscription.displayName,
                            planName: plan.name,
                            pricingTier: plan.properties.pricingTier,
                        });
                    }
                });
            }
        });

        console.log('Fetched plans:', plansData);
        res.json(plansData);
    } catch (error) {
        console.error('Error in /api/plans:', error.message);
        res.status(500).json({ error: 'Failed to fetch Defender plans' });
    }
});

// const port = process.env.PORT || 3000;
const port = 8080; // Temporarily hardcode to 8080 for testing

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});