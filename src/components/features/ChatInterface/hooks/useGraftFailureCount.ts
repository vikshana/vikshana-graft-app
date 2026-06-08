import { useEffect, useState } from 'react';
import { listGraftFailures, subscribeGraftFailures } from '../../../../services/graftOperatorFailureLog';

export function useGraftFailureCount(): number {
    const [count, setCount] = useState(() => listGraftFailures().length);

    useEffect(() => {
        return subscribeGraftFailures(() => {
            setCount(listGraftFailures().length);
        });
    }, []);

    return count;
}
