import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';

export interface Official { id: string; name: string; role: string; }

export const raceApi = createApi({
  reducerPath: 'raceApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getOfficials: builder.query<Official[], void>({
      queryFn: async () => ({ data: [
        { id: 'o1', name: '陈港', role: '竞赛官' },
        { id: 'o2', name: '宋宁', role: '仲裁主席' },
        { id: 'o3', name: '罗夏', role: '计时员' }
      ] })
    })
  })
});

export const { useGetOfficialsQuery } = raceApi;
